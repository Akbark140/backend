/**
 * @file transactionProcessor.js
 * @module TransactionProcessor
 * @version 2.0.0
 *
 * Enterprise-grade Background Transaction Processing Engine
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BULLMQ + REDIS?
 * ─────────────────────────────────────────────────────────────────────────────
 * BullMQ uses Redis as a durable, atomic queue backend. Redis LIST + ZSET
 * operations are atomic at the server level, giving us:
 *
 *   1. EXACTLY-ONCE semantics via BRPOPLPUSH / LMOVE (job moves from
 *      "waiting" → "active" atomically — no two workers can claim the same job)
 *   2. PERSISTENCE — AOF/RDB ensures jobs survive Redis restarts
 *   3. VISIBILITY TIMEOUT — if a worker crashes, the job re-appears after
 *      a configurable lock duration (BullMQ's "stalled" job mechanism)
 *   4. PRIORITY — Redis ZSETs allow O(log N) priority-ordered dequeuing
 *   5. DELAYED JOBS — ZSETs keyed by execution timestamp
 *
 * Alternative considered: Kafka. Kafka is better for ordered event streams
 * at massive scale. BullMQ wins for per-job retry semantics, backoff,
 * dead-letter queues, and operational simplicity for fintech job workloads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE (layers, top → bottom)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │            REST / GraphQL / Event Consumer              │  ← callers
 *   ├─────────────────────────────────────────────────────────┤
 *   │              TransactionQueueService                    │  ← application layer
 *   │   (enqueue, prioritize, schedule, deduplicate)          │
 *   ├─────────────────────────────────────────────────────────┤
 *   │          QueueRegistry  │  ProcessorRegistry            │  ← domain layer
 *   │     (manages BullMQ     │  (maps job types to          │
 *   │      Queue instances)   │   handler strategies)         │
 *   ├─────────────────────────────────────────────────────────┤
 *   │          WorkerOrchestrator + WorkerPool                │  ← infra layer
 *   │        (lifecycle, scaling, graceful shutdown)          │
 *   ├─────────────────────────────────────────────────────────┤
 *   │   Middleware Pipeline → Processor Handlers              │  ← execution layer
 *   │  (validate → idempotency → lock → execute → audit)      │
 *   ├─────────────────────────────────────────────────────────┤
 *   │              Redis (ioredis cluster)                    │  ← persistence
 *   └─────────────────────────────────────────────────────────┘
 *
 * @author  FinTech Engineering Team
 * @license MIT
 */

'use strict';

const { Queue, Worker, QueueEvents, MetricsTime } = require('bullmq');
const { EventEmitter }  = require('events');
const { v4: uuidv4 }    = require('uuid');
const Decimal           = require('decimal.js');
const crypto            = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// PRECISION CONFIG — financial-grade, no IEEE 754 drift
// ─────────────────────────────────────────────────────────────────────────────
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & ENUMERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Job type registry — canonical identifiers for every financial operation.
 * Using constants (not strings) prevents typo-based routing bugs.
 */
const JobType = Object.freeze({
  // Ledger operations
  LEDGER_POST:           'ledger:post',
  LEDGER_REVERSE:        'ledger:reverse',
  LEDGER_RECONCILE:      'ledger:reconcile',

  // Payment operations
  PAYMENT_INITIATE:      'payment:initiate',
  PAYMENT_SETTLE:        'payment:settle',
  PAYMENT_REFUND:        'payment:refund',

  // Currency operations
  FX_CONVERT:            'fx:convert',
  FX_RATE_SNAPSHOT:      'fx:rate:snapshot',

  // Invoice operations
  INVOICE_GENERATE:      'invoice:generate',
  INVOICE_SEND:          'invoice:send',
  INVOICE_BATCH:         'invoice:batch',

  // Fraud & compliance
  FRAUD_CHECK:           'fraud:check',
  AML_SCREEN:            'aml:screen',
  SANCTIONS_CHECK:       'sanctions:check',

  // Notifications
  NOTIFY_EMAIL:          'notify:email',
  NOTIFY_SMS:            'notify:sms',
  NOTIFY_WEBHOOK:        'notify:webhook',
  NOTIFY_PUSH:           'notify:push',

  // Batch & settlement
  BATCH_PROCESS:         'batch:process',
  SETTLEMENT_RUN:        'settlement:run',
  RECONCILIATION_BATCH:  'reconciliation:batch',

  // Audit
  AUDIT_LOG:             'audit:log',
});

/**
 * Queue names — each queue isolates a concern and can be scaled independently.
 * Separation allows per-queue concurrency, rate limits, and Redis key namespacing.
 */
const QueueName = Object.freeze({
  CRITICAL:       'txn:critical',       // P0: payments, settlements (highest priority)
  LEDGER:         'txn:ledger',         // P1: ledger postings
  COMPLIANCE:     'txn:compliance',     // P1: fraud, AML, sanctions
  INVOICING:      'txn:invoicing',      // P2: invoice generation/sending
  NOTIFICATION:   'txn:notification',   // P3: email, SMS, webhook
  BATCH:          'txn:batch',          // P4: reconciliation, settlement runs
  DEAD_LETTER:    'txn:dlq',            // DLQ: permanently failed jobs for inspection
  AUDIT:          'txn:audit',          // Audit trail — never retried, append-only
});

/**
 * Priority levels — lower number = higher priority in BullMQ.
 * Critical financial operations preempt notifications at the Redis queue level.
 */
const Priority = Object.freeze({
  CRITICAL:  1,
  HIGH:      10,
  NORMAL:    50,
  LOW:       100,
  BATCH:     200,
});

const ProcessingStatus = Object.freeze({
  QUEUED:     'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED:  'COMPLETED',
  FAILED:     'FAILED',
  DLQ:        'DLQ',
  CANCELLED:  'CANCELLED',
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM EXCEPTIONS
// ─────────────────────────────────────────────────────────────────────────────

class ProcessorError extends Error {
  constructor(message, code, context = {}, retryable = true) {
    super(message);
    this.name      = 'ProcessorError';
    this.code      = code;
    this.context   = context;
    this.retryable = retryable;   // non-retryable errors go straight to DLQ
    if (Error.captureStackTrace) Error.captureStackTrace(this, ProcessorError);
  }
}

class DuplicateJobError extends ProcessorError {
  constructor(idempotencyKey) {
    super(`Duplicate job detected: ${idempotencyKey}`, 'ERR_DUPLICATE_JOB', { idempotencyKey }, false);
    this.name = 'DuplicateJobError';
  }
}

class ValidationError extends ProcessorError {
  constructor(message, fields) {
    super(message, 'ERR_VALIDATION', { fields }, false); // invalid payload — no point retrying
    this.name = 'ValidationError';
  }
}

class InsufficientFundsError extends ProcessorError {
  constructor(accountId, required, available) {
    super(
      `Insufficient funds in account ${accountId}: required=${required} available=${available}`,
      'ERR_INSUFFICIENT_FUNDS',
      { accountId, required, available },
      false  // not retryable without user action
    );
    this.name = 'InsufficientFundsError';
  }
}

class TransientError extends ProcessorError {
  constructor(message, context) {
    super(message, 'ERR_TRANSIENT', context, true); // always retryable
    this.name = 'TransientError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REDIS CONNECTION FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RedisConnectionFactory — manages ioredis connections for BullMQ.
 *
 * BullMQ requires SEPARATE connections for Queue and Worker instances.
 * A single shared connection causes "blocking command" errors because
 * workers use BRPOPLPUSH (a blocking Redis command) which monopolizes
 * the connection. Never share connections between Queue and Worker.
 *
 * In production: use ioredis Cluster for horizontal Redis scaling.
 * enableReadyCheck + maxRetriesPerRequest=null is REQUIRED by BullMQ.
 */
class RedisConnectionFactory {
  #config;
  #connections = [];

  constructor(config = {}) {
    this.#config = {
      host:                  config.host     || process.env.REDIS_HOST     || '127.0.0.1',
      port:                  config.port     || process.env.REDIS_PORT     || 6379,
      password:              config.password || process.env.REDIS_PASSWORD || undefined,
      db:                    config.db       || 0,
      // BullMQ mandatory settings:
      enableReadyCheck:      false,
      maxRetriesPerRequest:  null,
      // Reconnection strategy: exponential backoff up to 30s
      retryStrategy: (times) => Math.min(times * 500, 30_000),
      // Lazy connect: don't fail at construction time if Redis is down
      lazyConnect: false,
    };
  }

  /**
   * Create a new connection. BullMQ manages its own connection lifecycle —
   * never reuse the same ioredis instance across Queue + Worker.
   */
  create(role = 'default') {
    // Dynamic require to avoid hard dependency if using connection pooling differently
    const IORedis = require('ioredis');
    const conn    = new IORedis(this.#config);

    conn.on('connect',           () => logger.info(`[Redis:${role}] Connected`));
    conn.on('ready',             () => logger.info(`[Redis:${role}] Ready`));
    conn.on('error',             (err) => logger.error(`[Redis:${role}] Error: ${err.message}`));
    conn.on('close',             () => logger.warn(`[Redis:${role}] Connection closed`));
    conn.on('reconnecting',      () => logger.warn(`[Redis:${role}] Reconnecting...`));

    this.#connections.push(conn);
    return conn;
  }

  async closeAll() {
    await Promise.all(this.#connections.map(c => c.quit().catch(() => {})));
    this.#connections = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURED LOGGER
// Pino is preferred in production (10x faster than Winston due to async I/O).
// Using a thin abstraction so we can swap implementations without touching callers.
// ─────────────────────────────────────────────────────────────────────────────

const logger = (() => {
  // Try pino first; fall back to console with structured output
  try {
    const pino = require('pino');
    return pino({
      level:    process.env.LOG_LEVEL || 'info',
      redact:   ['job.data.cardNumber', 'job.data.cvv', 'job.data.password', 'job.data.pin'],
      serializers: {
        job: (j) => ({ id: j.id, name: j.name, attempt: j.attemptsMade }),
      },
    });
  } catch {
    // Console fallback with JSON lines
    const levels = { error: 50, warn: 40, info: 30, debug: 20 };
    const level  = process.env.LOG_LEVEL || 'info';
    const methods = {};
    for (const [name, num] of Object.entries(levels)) {
      methods[name] = (obj, msg) => {
        if (num >= (levels[level] || 30)) {
          process.stdout.write(JSON.stringify({
            level: num, name, time: Date.now(),
            msg: typeof obj === 'string' ? obj : msg,
            ...(typeof obj === 'object' ? obj : {}),
          }) + '\n');
        }
      };
    }
    return methods;
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// JOB PAYLOAD VALIDATOR
// Validate BEFORE enqueuing — bad payloads must never enter the queue.
// In production, use Zod for compile-time type inference + runtime validation.
// ─────────────────────────────────────────────────────────────────────────────

class JobPayloadValidator {
  // Schema registry — maps job type to validation function
  static #schemas = new Map();

  static register(jobType, validateFn) {
    this.#schemas.set(jobType, validateFn);
  }

  static validate(jobType, payload) {
    const validate = this.#schemas.get(jobType);
    if (!validate) return; // no schema registered → allow (log warning in production)

    const result = validate(payload);
    if (result && result.errors) {
      throw new ValidationError(`Invalid payload for job type ${jobType}`, result.errors);
    }
  }
}

// Register built-in schemas (simplified — production uses Zod/Joi full schemas)
JobPayloadValidator.register(JobType.LEDGER_POST, (payload) => {
  const errors = [];
  if (!payload.transactionId) errors.push('transactionId is required');
  if (!payload.entries || !Array.isArray(payload.entries) || payload.entries.length < 2)
    errors.push('entries must be an array with at least 2 items');
  if (!payload.reference) errors.push('reference is required');
  return errors.length ? { errors } : null;
});

JobPayloadValidator.register(JobType.PAYMENT_INITIATE, (payload) => {
  const errors = [];
  if (!payload.fromAccountId)  errors.push('fromAccountId is required');
  if (!payload.toAccountId)    errors.push('toAccountId is required');
  if (!payload.amount || parseFloat(payload.amount) <= 0) errors.push('amount must be positive');
  if (!payload.currency)       errors.push('currency is required');
  return errors.length ? { errors } : null;
});

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY STORE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IdempotencyStore — prevents duplicate financial operations.
 *
 * HOW IT WORKS:
 * Before executing a job, the worker tries to SET a Redis key
 * with NX (set if not exists) + EX (expire). If SET returns null,
 * the key already exists → job was already processed → skip.
 *
 * Key format: `idempotency:{jobType}:{idempotencyKey}`
 * TTL: 7 days (window where duplicates are likely to arrive)
 *
 * WHY REDIS AND NOT DB:
 * Redis SETNX is atomic and O(1). A DB check requires a round-trip
 * + index scan. For high-throughput job processing, Redis wins.
 * The DB unique constraint is a secondary safety net, not the primary.
 */
class IdempotencyStore {
  #redis;
  #ttlSeconds;

  constructor(redisConnection, ttlSeconds = 7 * 24 * 3600) {
    this.#redis      = redisConnection;
    this.#ttlSeconds = ttlSeconds;
  }

  /**
   * Try to claim the idempotency key.
   * Returns true if claimed (first time), false if already exists (duplicate).
   */
  async claim(jobType, idempotencyKey) {
    const key    = `idempotency:${jobType}:${idempotencyKey}`;
    const result = await this.#redis.set(key, '1', 'EX', this.#ttlSeconds, 'NX');
    return result === 'OK'; // 'OK' = claimed; null = already exists
  }

  async release(jobType, idempotencyKey) {
    const key = `idempotency:${jobType}:${idempotencyKey}`;
    await this.#redis.del(key);
  }

  async isProcessed(jobType, idempotencyKey) {
    const key = `idempotency:${jobType}:${idempotencyKey}`;
    return (await this.#redis.exists(key)) === 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISTRIBUTED LOCK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DistributedLock — prevents concurrent processing of the same resource.
 *
 * Uses the Redlock algorithm (single-node simplified version).
 * For production with Redis Cluster: use the `redlock` npm package which
 * implements the full Redlock algorithm across N Redis nodes.
 *
 * A lock on accountId prevents two workers from posting to the same account
 * simultaneously — which would cause a balance race condition.
 */
class DistributedLock {
  #redis;

  constructor(redisConnection) {
    this.#redis = redisConnection;
  }

  /**
   * Acquire a lock. Returns a token to use for release (prevents lock theft).
   * @param {string} resource - e.g., `account:${accountId}`
   * @param {number} ttlMs    - auto-release after ttlMs milliseconds
   */
  async acquire(resource, ttlMs = 30_000) {
    const key   = `lock:${resource}`;
    const token = uuidv4();
    // SET key token NX PX ttlMs — atomic: only sets if key doesn't exist
    const result = await this.#redis.set(key, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return null; // lock held by another process
    return { resource, key, token, acquiredAt: Date.now(), ttlMs };
  }

  /**
   * Release lock ONLY if we still own it (compare token before delete).
   * Uses a Lua script for atomic compare-and-delete.
   */
  async release(lock) {
    if (!lock) return false;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.#redis.eval(script, 1, lock.key, lock.token);
    return result === 1;
  }

  /**
   * Extend the lock TTL (for long-running jobs that need to renew their lock).
   */
  async extend(lock, additionalMs) {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    return await this.#redis.eval(script, 1, lock.key, lock.token, additionalMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QueueRegistry — manages all BullMQ Queue instances.
 *
 * Centralizes queue creation so every caller gets the same configured
 * Queue object. Queue instances are heavy (Redis connection per queue) —
 * sharing instances is critical.
 *
 * Default job options are set at queue level — individual jobs can override.
 */
class QueueRegistry {
  #queues    = new Map();
  #redis;
  #defaultJobOptions;

  constructor(redisConnectionFactory) {
    this.#redis = redisConnectionFactory;
    this.#defaultJobOptions = {
      attempts:    5,
      backoff: {
        type:  'exponential',
        delay: 2000,     // 2s → 4s → 8s → 16s → 32s (max 5 attempts)
      },
      removeOnComplete: { count: 1000, age: 24 * 3600 }, // keep last 1000 completed jobs for 24h
      removeOnFail:     { count: 5000, age: 7 * 24 * 3600 }, // keep failed jobs 7 days
    };
  }

  /**
   * Get or create a BullMQ Queue.
   * Lazy initialization — only creates connections when a queue is first accessed.
   */
  getQueue(queueName, options = {}) {
    if (this.#queues.has(queueName)) return this.#queues.get(queueName);

    const queue = new Queue(queueName, {
      connection: this.#redis.create(`queue:${queueName}`),
      defaultJobOptions: { ...this.#defaultJobOptions, ...options.defaultJobOptions },
      streams: {
        events: {
          maxLen: 10_000, // cap the BullMQ events stream to prevent Redis OOM
        },
      },
    });

    queue.on('error', (err) =>
      logger.error({ queueName, err: err.message }, '[Queue] Error')
    );

    this.#queues.set(queueName, queue);
    logger.info({ queueName }, '[QueueRegistry] Queue initialized');
    return queue;
  }

  async closeAll() {
    await Promise.all([...this.#queues.values()].map(q => q.close()));
    this.#queues.clear();
  }

  getQueueNames() { return [...this.#queues.keys()]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESSOR REGISTRY — Strategy Pattern
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ProcessorRegistry — maps job types to handler functions.
 *
 * Strategy pattern: the Worker doesn't know HOW to process a payment —
 * it just dispatches to the registered processor for that job type.
 * New job types are added by registering a handler, not by modifying the worker.
 * This is the Open/Closed principle in action.
 */
class ProcessorRegistry {
  #processors = new Map(); // jobType → async handler function

  /**
   * Register a processor for a job type.
   * @param {string}   jobType   - e.g., JobType.LEDGER_POST
   * @param {Function} processor - async (job, context) => result
   */
  register(jobType, processor) {
    if (this.#processors.has(jobType)) {
      logger.warn({ jobType }, '[ProcessorRegistry] Overwriting existing processor');
    }
    this.#processors.set(jobType, processor);
    logger.info({ jobType }, '[ProcessorRegistry] Processor registered');
  }

  get(jobType) {
    const processor = this.#processors.get(jobType);
    if (!processor) {
      throw new ProcessorError(
        `No processor registered for job type: ${jobType}`,
        'ERR_NO_PROCESSOR',
        { jobType },
        false  // not retryable — missing handler is a code bug
      );
    }
    return processor;
  }

  has(jobType)  { return this.#processors.has(jobType); }
  getAll()      { return new Map(this.#processors); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MiddlewarePipeline — compose middleware around job execution.
 *
 * Middleware executes in registration order. Each middleware wraps the next,
 * forming an onion model: validate → idempotency → lock → execute → audit.
 *
 * This pattern allows cross-cutting concerns (logging, tracing, rate limiting)
 * to be applied uniformly to all jobs without modifying individual processors.
 */
class MiddlewarePipeline {
  #middlewares = [];

  use(middleware) {
    this.#middlewares.push(middleware);
    return this; // fluent API
  }

  /**
   * Build the composed execution function.
   * Each middleware receives (job, context, next) — must call next() to continue.
   */
  compose() {
    const middlewares = [...this.#middlewares];
    return async function composed(job, context) {
      let idx = -1;
      const dispatch = async (i) => {
        if (i <= idx) throw new Error('next() called multiple times');
        idx = i;
        const fn = middlewares[i];
        if (!fn) return;
        await fn(job, context, () => dispatch(i + 1));
      };
      await dispatch(0);
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILT-IN MIDDLEWARES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validationMiddleware — validate job payload before processing.
 * Fail fast: a bad payload will never succeed regardless of retries.
 */
const validationMiddleware = async (job, context, next) => {
  const startAt = Date.now();
  try {
    JobPayloadValidator.validate(job.name, job.data);
    logger.debug({ jobId: job.id, jobType: job.name }, '[Middleware:Validation] Passed');
    await next();
  } catch (err) {
    if (err instanceof ValidationError) {
      // Mark as non-retryable by setting failedReason in BullMQ's native format
      err.retryable = false;
      logger.error({ jobId: job.id, fields: err.context.fields }, '[Middleware:Validation] Failed');
    }
    throw err;
  } finally {
    context.timings = context.timings || {};
    context.timings.validation = Date.now() - startAt;
  }
};

/**
 * idempotencyMiddleware — prevent double-execution of the same financial operation.
 *
 * Flow:
 *   1. Try to claim the idempotency key
 *   2. If already claimed → DuplicateJobError (non-retryable, treated as success)
 *   3. If claimed → execute → release on failure for retry
 *
 * WHY RELEASE ON FAILURE:
 * If processing fails, we WANT a retry to succeed. So we only keep the
 * idempotency key permanently if the job COMPLETES successfully.
 * On failure, we release the key so the next attempt can reclaim it.
 */
const createIdempotencyMiddleware = (idempotencyStore) => async (job, context, next) => {
  const key = job.data.idempotencyKey || job.id;

  const claimed = await idempotencyStore.claim(job.name, key);
  if (!claimed) {
    logger.warn({ jobId: job.id, idempotencyKey: key }, '[Middleware:Idempotency] Duplicate detected — skipping');
    context.isDuplicate = true;
    // Don't throw — return gracefully. BullMQ will mark job as completed.
    return;
  }

  context.idempotencyKey = key;
  try {
    await next();
    // On success: key remains in Redis (TTL prevents reprocessing within window)
  } catch (err) {
    // On failure: release key so retry attempt can reclaim
    if (err.retryable !== false) {
      await idempotencyStore.release(job.name, key);
    }
    throw err;
  }
};

/**
 * loggingMiddleware — structured logging with timing and outcome.
 * Adds distributed tracing context (traceId) for correlation across services.
 */
const loggingMiddleware = async (job, context, next) => {
  const traceId  = job.data.traceId || uuidv4();
  context.traceId = traceId;
  const startAt  = Date.now();

  logger.info({
    traceId,
    jobId:    job.id,
    jobType:  job.name,
    attempt:  job.attemptsMade + 1,
    queue:    job.queueName,
    ref:      job.data.reference,
  }, '[Processor] Job started');

  try {
    await next();
    const durationMs = Date.now() - startAt;
    logger.info({ traceId, jobId: job.id, durationMs }, '[Processor] Job completed');
  } catch (err) {
    const durationMs = Date.now() - startAt;
    logger.error({
      traceId,
      jobId:       job.id,
      jobType:     job.name,
      durationMs,
      error:       err.message,
      code:        err.code,
      retryable:   err.retryable,
      attempt:     job.attemptsMade + 1,
      maxAttempts: job.opts?.attempts,
    }, '[Processor] Job failed');
    throw err;
  }
};

/**
 * metricsMiddleware — emit timing/outcome metrics for Prometheus/DataDog.
 * In production: replace the Map with actual StatsD or Prometheus client calls.
 */
const metricsMiddleware = async (job, context, next) => {
  const startAt = process.hrtime.bigint();
  let outcome   = 'success';

  try {
    await next();
  } catch (err) {
    outcome = err.retryable === false ? 'failed_permanent' : 'failed_transient';
    throw err;
  } finally {
    const durationNs = Number(process.hrtime.bigint() - startAt);
    const durationMs = durationNs / 1_000_000;

    // In production: metrics.histogram('job.duration', durationMs, { jobType: job.name, outcome })
    //                metrics.increment('job.count', { jobType: job.name, outcome })
    MetricsCollector.record(job.name, outcome, durationMs);
  }
};

/**
 * retryStrategyMiddleware — customise retry behaviour per error type.
 *
 * BullMQ's built-in retry is uniform. This middleware intercepts errors
 * and can modify the job's next attempt delay dynamically.
 * Non-retryable errors throw a special marker that the WorkerOrchestrator
 * catches to route the job to the DLQ immediately.
 */
const retryStrategyMiddleware = async (job, context, next) => {
  try {
    await next();
  } catch (err) {
    if (err.retryable === false) {
      // Attach marker — WorkerOrchestrator's failed handler reads this
      err.moveToDeadLetter = true;
    }
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// METRICS COLLECTOR (lightweight in-process store)
// ─────────────────────────────────────────────────────────────────────────────

class MetricsCollector {
  static #data = new Map();

  static record(jobType, outcome, durationMs) {
    const key  = `${jobType}:${outcome}`;
    const prev = this.#data.get(key) || { count: 0, totalMs: 0, maxMs: 0 };
    this.#data.set(key, {
      count:   prev.count + 1,
      totalMs: prev.totalMs + durationMs,
      maxMs:   Math.max(prev.maxMs, durationMs),
    });
  }

  static getMetrics() {
    const result = {};
    for (const [key, val] of this.#data) {
      result[key] = {
        ...val,
        avgMs: val.count > 0 ? (val.totalMs / val.count).toFixed(2) : 0,
      };
    }
    return result;
  }

  static reset() { this.#data.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WorkerOrchestrator — manages the lifecycle of BullMQ Workers.
 *
 * One Worker per queue is the recommended BullMQ pattern.
 * Concurrency is set per-worker: a concurrency of 10 means 10 jobs
 * execute in parallel within a single Node.js event loop.
 *
 * For CPU-intensive jobs (e.g., PDF generation, crypto ops): use
 * worker_threads to avoid blocking the event loop. The WorkerThread
 * pool pattern isolates CPU work to separate threads.
 *
 * GRACEFUL SHUTDOWN:
 * 1. Stop accepting new jobs (worker.pause())
 * 2. Wait for in-flight jobs to complete (worker.close())
 * 3. Close queue connections
 * This prevents split-brain: a job that was "processing" when the
 * process died would be recovered by BullMQ's stalled job detector.
 */
class WorkerOrchestrator {
  #workers        = new Map();  // queueName → Worker
  #registry;
  #redis;
  #pipeline;
  #dlqQueue;
  #idempotency;
  #lock;
  #isShuttingDown = false;

  constructor({ processorRegistry, redisFactory, dlqQueue, idempotencyStore, distributedLock }) {
    this.#registry    = processorRegistry;
    this.#redis       = redisFactory;
    this.#dlqQueue    = dlqQueue;
    this.#idempotency = idempotencyStore;
    this.#lock        = distributedLock;

    // Build middleware pipeline — order matters
    this.#pipeline = new MiddlewarePipeline()
      .use(loggingMiddleware)
      .use(metricsMiddleware)
      .use(validationMiddleware)
      .use(createIdempotencyMiddleware(idempotencyStore))
      .use(retryStrategyMiddleware)
      .compose();
  }

  /**
   * Start a worker for a queue.
   *
   * @param {string} queueName
   * @param {Object} options
   * @param {number} [options.concurrency=5]   - parallel jobs per worker process
   * @param {number} [options.limiter]         - rate limiter (max N jobs per duration)
   */
  startWorker(queueName, options = {}) {
    if (this.#workers.has(queueName)) {
      logger.warn({ queueName }, '[WorkerOrchestrator] Worker already running');
      return this.#workers.get(queueName);
    }

    const {
      concurrency = 5,
      limiter     = null,  // e.g., { max: 100, duration: 1000 } — 100 jobs/sec
    } = options;

    const worker = new Worker(
      queueName,
      async (job) => this.#executeJob(job),
      {
        connection:  this.#redis.create(`worker:${queueName}`),
        concurrency,
        limiter,
        // BullMQ lock duration — if job takes longer, it's considered "stalled"
        // and re-queued. Set higher than your slowest expected job.
        lockDuration: 60_000,     // 60 seconds
        lockRenewTime: 15_000,    // renew lock every 15s for long-running jobs
        // Stalled jobs: recover jobs that were "in progress" when a worker crashed
        stalledInterval: 30_000,  // check for stalled jobs every 30s
        maxStalledCount: 2,       // after 2 stalls, move to failed
      }
    );

    // Worker event handlers — observability hooks
    worker.on('completed', (job) => {
      logger.info({ jobId: job.id, jobType: job.name, queueName }, '[Worker] Job completed');
    });

    worker.on('failed', async (job, err) => {
      logger.error({
        jobId:     job?.id,
        jobType:   job?.name,
        attempt:   job?.attemptsMade,
        error:     err.message,
        retryable: err.retryable,
      }, '[Worker] Job failed');

      // Route non-retryable failures to DLQ immediately
      if (err.moveToDeadLetter || err.retryable === false) {
        await this.#moveToDLQ(job, err);
      }
    });

    worker.on('stalled', (jobId) => {
      logger.warn({ jobId, queueName }, '[Worker] Job stalled — will be re-queued');
    });

    worker.on('error', (err) => {
      logger.error({ queueName, error: err.message }, '[Worker] Worker-level error');
    });

    // Auto-restart on unhandled errors (in production: use PM2/k8s restart policy)
    worker.on('error', (err) => {
      if (!this.#isShuttingDown) {
        logger.warn({ queueName }, '[Worker] Scheduling worker restart...');
        setTimeout(() => this.startWorker(queueName, options), 5000);
      }
    });

    this.#workers.set(queueName, worker);
    logger.info({ queueName, concurrency }, '[WorkerOrchestrator] Worker started');
    return worker;
  }

  /**
   * Core job execution — wraps processor in middleware pipeline.
   * This is the function BullMQ calls for each job.
   */
  async #executeJob(job) {
    if (this.#isShuttingDown) {
      // Reject new jobs during shutdown — BullMQ will re-queue them
      throw new TransientError('Worker is shutting down', { jobId: job.id });
    }

    const context = {
      distributedLock:  this.#lock,
      idempotencyStore: this.#idempotency,
      result:           null,
    };

    // Middleware pipeline wraps the processor execution
    await this.#pipeline(job, context);

    // If not a duplicate and not already handled by middleware
    if (!context.isDuplicate) {
      const processor = this.#registry.get(job.name);
      context.result  = await processor(job, context);
    }

    return context.result;
  }

  /**
   * Move a permanently failed job to the Dead Letter Queue.
   *
   * DLQ jobs are never retried automatically. An operator must:
   *   1. Inspect the job and understand the failure
   *   2. Fix the root cause
   *   3. Manually re-queue from the DLQ if appropriate
   */
  async #moveToDLQ(job, error) {
    if (!job || !this.#dlqQueue) return;

    try {
      await this.#dlqQueue.add(
        'dead-letter',
        {
          originalQueue:   job.queueName,
          originalJobId:   job.id,
          originalJobName: job.name,
          originalData:    job.data,
          failureReason:   error.message,
          errorCode:       error.code,
          failedAt:        new Date().toISOString(),
          attemptsMade:    job.attemptsMade,
        },
        {
          attempts:         1,        // DLQ jobs should not be retried
          removeOnComplete: false,    // keep DLQ jobs indefinitely for inspection
          removeOnFail:     false,
        }
      );
      logger.warn({ originalJobId: job.id, reason: error.message }, '[Worker] Job moved to DLQ');
    } catch (dlqErr) {
      logger.error({ dlqErr: dlqErr.message }, '[Worker] Failed to move job to DLQ');
    }
  }

  /**
   * Graceful shutdown — drain in-flight jobs before exiting.
   * Called by SIGTERM/SIGINT handlers.
   */
  async shutdown(timeoutMs = 30_000) {
    this.#isShuttingDown = true;
    logger.info('[WorkerOrchestrator] Initiating graceful shutdown...');

    const shutdownPromises = [...this.#workers.values()].map(w =>
      Promise.race([
        w.close(),  // waits for in-flight jobs to complete
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Worker shutdown timeout')), timeoutMs)
        ),
      ]).catch(err => logger.error({ error: err.message }, '[WorkerOrchestrator] Shutdown error'))
    );

    await Promise.all(shutdownPromises);
    this.#workers.clear();
    logger.info('[WorkerOrchestrator] All workers stopped');
  }

  getWorkerCount() { return this.#workers.size; }
  getWorkerNames() { return [...this.#workers.keys()]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION QUEUE SERVICE — Application Layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TransactionQueueService — the public API for enqueuing financial jobs.
 *
 * This is the ONLY way external code should interact with the queue system.
 * Encapsulates: queue selection, priority mapping, deduplication, scheduling.
 */
class TransactionQueueService {
  #registry;

  constructor(queueRegistry) {
    this.#registry = queueRegistry;
  }

  /**
   * Enqueue a financial job.
   *
   * @param {string} jobType         - from JobType enum
   * @param {Object} payload         - job-specific data
   * @param {Object} [options]
   * @param {number} [options.priority]       - Priority enum value
   * @param {number} [options.delayMs]        - delay before processing
   * @param {string} [options.idempotencyKey] - deduplication key
   * @param {number} [options.attempts]       - override default retry count
   */
  async enqueue(jobType, payload, options = {}) {
    const {
      priority       = Priority.NORMAL,
      delayMs        = 0,
      idempotencyKey = uuidv4(),
      attempts,
    } = options;

    // Validate before accepting into queue — fail fast
    JobPayloadValidator.validate(jobType, payload);

    const queueName = this.#resolveQueue(jobType, priority);
    const queue     = this.#registry.getQueue(queueName);

    // Generate a deterministic job ID from the idempotency key.
    // BullMQ uses job ID for deduplication at the queue level (secondary safety net).
    const jobId = this.#generateJobId(jobType, idempotencyKey);

    const job = await queue.add(
      jobType,
      {
        ...payload,
        idempotencyKey,
        traceId:   payload.traceId || uuidv4(),
        enqueuedAt: new Date().toISOString(),
      },
      {
        jobId,
        priority,
        delay:     delayMs,
        attempts:  attempts || undefined,  // use queue default if not specified
      }
    );

    logger.info({
      jobId:   job.id,
      jobType,
      queueName,
      priority,
      delayMs,
      idempotencyKey,
    }, '[TransactionQueueService] Job enqueued');

    return {
      jobId:         job.id,
      queueName,
      jobType,
      idempotencyKey,
      status:        ProcessingStatus.QUEUED,
      enqueuedAt:    new Date().toISOString(),
    };
  }

  /**
   * Enqueue a batch of jobs efficiently.
   * Uses queue.addBulk() for a single Redis pipeline — far more efficient
   * than N individual calls for large batches.
   */
  async enqueueBatch(jobs) {
    // Group jobs by queue for minimal Redis round-trips
    const byQueue = new Map();
    for (const { jobType, payload, options = {} } of jobs) {
      const queueName = this.#resolveQueue(jobType, options.priority || Priority.NORMAL);
      if (!byQueue.has(queueName)) byQueue.set(queueName, []);
      byQueue.get(queueName).push({ jobType, payload, options });
    }

    const results = [];
    for (const [queueName, queueJobs] of byQueue) {
      const queue     = this.#registry.getQueue(queueName);
      const bulkJobs  = queueJobs.map(({ jobType, payload, options }) => ({
        name: jobType,
        data: {
          ...payload,
          idempotencyKey: options.idempotencyKey || uuidv4(),
          traceId:        payload.traceId || uuidv4(),
          enqueuedAt:     new Date().toISOString(),
        },
        opts: {
          priority: options.priority || Priority.NORMAL,
          delay:    options.delayMs || 0,
        },
      }));

      const added = await queue.addBulk(bulkJobs);
      results.push(...added.map(j => ({ jobId: j.id, queueName, status: ProcessingStatus.QUEUED })));
    }

    logger.info({ count: results.length }, '[TransactionQueueService] Batch enqueued');
    return results;
  }

  /**
   * Get job status — useful for polling from REST handlers.
   */
  async getJobStatus(queueName, jobId) {
    const queue = this.#registry.getQueue(queueName);
    const job   = await queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      jobId,
      jobType: job.name,
      state,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      returnvalue:  job.returnvalue,
      timestamp:    job.timestamp,
      finishedOn:   job.finishedOn,
    };
  }

  /**
   * Cancel a queued (waiting) job.
   * Cannot cancel jobs that are already processing.
   */
  async cancelJob(queueName, jobId) {
    const queue = this.#registry.getQueue(queueName);
    const job   = await queue.getJob(jobId);
    if (!job) throw new ProcessorError(`Job not found: ${jobId}`, 'ERR_JOB_NOT_FOUND', {}, false);
    const state = await job.getState();
    if (state !== 'waiting' && state !== 'delayed') {
      throw new ProcessorError(
        `Cannot cancel job in state: ${state}`,
        'ERR_CANNOT_CANCEL',
        { jobId, state },
        false
      );
    }
    await job.remove();
    return { jobId, cancelled: true };
  }

  /**
   * Map job type + priority to the appropriate queue.
   * This routing logic can be extended with tenant-based partitioning,
   * e.g., `txn:critical:tenant-abc` for dedicated queues per customer.
   */
  #resolveQueue(jobType, priority) {
    if (priority === Priority.CRITICAL) return QueueName.CRITICAL;

    const routingMap = {
      [JobType.LEDGER_POST]:          QueueName.LEDGER,
      [JobType.LEDGER_REVERSE]:       QueueName.LEDGER,
      [JobType.LEDGER_RECONCILE]:     QueueName.BATCH,
      [JobType.PAYMENT_INITIATE]:     QueueName.CRITICAL,
      [JobType.PAYMENT_SETTLE]:       QueueName.CRITICAL,
      [JobType.PAYMENT_REFUND]:       QueueName.CRITICAL,
      [JobType.FX_CONVERT]:           QueueName.LEDGER,
      [JobType.INVOICE_GENERATE]:     QueueName.INVOICING,
      [JobType.INVOICE_SEND]:         QueueName.INVOICING,
      [JobType.INVOICE_BATCH]:        QueueName.BATCH,
      [JobType.FRAUD_CHECK]:          QueueName.COMPLIANCE,
      [JobType.AML_SCREEN]:           QueueName.COMPLIANCE,
      [JobType.SANCTIONS_CHECK]:      QueueName.COMPLIANCE,
      [JobType.NOTIFY_EMAIL]:         QueueName.NOTIFICATION,
      [JobType.NOTIFY_SMS]:           QueueName.NOTIFICATION,
      [JobType.NOTIFY_WEBHOOK]:       QueueName.NOTIFICATION,
      [JobType.BATCH_PROCESS]:        QueueName.BATCH,
      [JobType.SETTLEMENT_RUN]:       QueueName.BATCH,
      [JobType.RECONCILIATION_BATCH]: QueueName.BATCH,
      [JobType.AUDIT_LOG]:            QueueName.AUDIT,
    };

    return routingMap[jobType] || QueueName.BATCH;
  }

  /**
   * Generate a deterministic job ID from idempotency key.
   * SHA-256 ensures the ID is always valid length for BullMQ and
   * deterministic — the same idempotency key always produces the same job ID.
   */
  #generateJobId(jobType, idempotencyKey) {
    return crypto
      .createHash('sha256')
      .update(`${jobType}:${idempotencyKey}`)
      .digest('hex')
      .slice(0, 32); // BullMQ job IDs can be long but we keep them compact
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE PROCESSOR IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Example: Ledger Post Processor
 * In production: calls ledgerService.postJournalEntry()
 */
const ledgerPostProcessor = async (job, context) => {
  const { transactionId, entries, reference } = job.data;

  // Acquire distributed lock on each account to prevent concurrent balance mutations
  const accountIds = [...new Set(entries.map(e => e.accountId))];
  const locks      = [];

  try {
    for (const accountId of accountIds) {
      const lock = await context.distributedLock.acquire(`account:${accountId}`, 30_000);
      if (!lock) throw new TransientError(`Could not acquire lock for account ${accountId}`, { accountId });
      locks.push(lock);
    }

    // Simulate ledger posting (in production: call ledgerService)
    await new Promise(r => setTimeout(r, 10)); // I/O simulation

    logger.info({ transactionId, reference, entryCount: entries.length },
      '[LedgerPostProcessor] Transaction posted successfully');

    return { transactionId, status: 'POSTED', postedAt: new Date().toISOString() };
  } finally {
    // Always release locks — in try/finally to guarantee release
    await Promise.all(locks.map(l => context.distributedLock.release(l)));
  }
};

/**
 * Example: Payment Processor
 * In production: integrates with payment rails (SWIFT, SEPA, ACH, etc.)
 */
const paymentProcessor = async (job, context) => {
  const { fromAccountId, toAccountId, amount, currency, reference } = job.data;

  // Validate financial precision
  const decimalAmount = new Decimal(amount);
  if (decimalAmount.isNegative() || decimalAmount.isZero()) {
    throw new ValidationError('Payment amount must be positive', ['amount']);
  }

  // Simulate payment rail integration
  await new Promise(r => setTimeout(r, 50));

  logger.info({
    from: fromAccountId,
    to:   toAccountId,
    amount: decimalAmount.toFixed(2),
    currency,
    reference,
  }, '[PaymentProcessor] Payment initiated');

  return {
    paymentId:   uuidv4(),
    status:      'INITIATED',
    amount:      decimalAmount.toFixed(2),
    currency,
    initiatedAt: new Date().toISOString(),
  };
};

/**
 * Example: Fraud Check Processor
 */
const fraudCheckProcessor = async (job, context) => {
  const { transactionId, amount, fromAccountId } = job.data;
  const score = Math.random(); // production: call ML model

  const isFlagged = score > 0.85;
  logger.info({ transactionId, score: score.toFixed(4), isFlagged }, '[FraudCheckProcessor] Check completed');

  return { transactionId, fraudScore: score.toFixed(4), flagged: isFlagged, checkedAt: new Date().toISOString() };
};

/**
 * Example: Notification Processor
 */
const notifyEmailProcessor = async (job, context) => {
  // Mask sensitive data before logging (PII protection)
  const { to, subject, templateId } = job.data;
  const maskedTo = to.replace(/(.{2}).+(@.+)/, '$1***$2');

  logger.info({ to: maskedTo, subject, templateId }, '[NotifyEmailProcessor] Email queued');
  await new Promise(r => setTimeout(r, 20)); // simulate SMTP/SES call
  return { delivered: true, to: maskedTo, sentAt: new Date().toISOString() };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE MONITOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QueueMonitor — collects operational metrics from all queues.
 * Compatible with Bull Board / Arena dashboard integrations.
 */
class QueueMonitor {
  constructor(queueRegistry, redisFactory) {
    this.queueRegistry = queueRegistry;
    this.redisFactory  = redisFactory;
    this.queueEvents   = new Map();
  }

  /**
   * Attach QueueEvents listener to a queue for real-time event streaming.
   * QueueEvents uses a SEPARATE Redis connection (pub/sub).
   */
  attachQueueEvents(queueName) {
    if (this.queueEvents.has(queueName)) return;

    const qe = new QueueEvents(queueName, {
      connection: this.redisFactory.create(`monitor:${queueName}`),
    });

    qe.on('completed', ({ jobId, returnvalue }) =>
      logger.debug({ queueName, jobId }, '[Monitor] Job completed')
    );
    qe.on('failed', ({ jobId, failedReason }) =>
      logger.warn({ queueName, jobId, failedReason }, '[Monitor] Job failed')
    );
    qe.on('progress', ({ jobId, data }) =>
      logger.debug({ queueName, jobId, progress: data }, '[Monitor] Job progress')
    );

    this.queueEvents.set(queueName, qe);
  }

  async getQueueStats() {
    const stats = {};
    for (const queueName of this.queueRegistry.getQueueNames()) {
      const queue = this.queueRegistry.getQueue(queueName);
      const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.isPaused(),
      ]);
      stats[queueName] = { waiting, active, completed, failed, delayed, paused };
    }
    return stats;
  }

  async getHealthCheck() {
    const stats  = await this.getQueueStats();
    const metrics = MetricsCollector.getMetrics();
    const healthy = Object.values(stats).every(s => s.active < 1000); // example threshold

    return {
      healthy,
      queues:   stats,
      metrics,
      checkedAt: new Date().toISOString(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION PROCESSOR FACTORY — Composition Root
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createTransactionProcessor — assembles and wires the complete system.
 *
 * All dependencies are created here and injected downward.
 * No global singletons — makes testing easy (inject mocks).
 */
function createTransactionProcessor(config = {}) {
  const redisFactory = new RedisConnectionFactory(config.redis || {});

  // Shared Redis client for idempotency & locking (separate from BullMQ connections)
  const sharedRedis = redisFactory.create('shared');

  const idempotencyStore = new IdempotencyStore(sharedRedis);
  const distributedLock  = new DistributedLock(sharedRedis);
  const queueRegistry    = new QueueRegistry(redisFactory);
  const processorRegistry = new ProcessorRegistry();

  // Initialize all queues upfront
  for (const queueName of Object.values(QueueName)) {
    queueRegistry.getQueue(queueName);
  }

  const dlqQueue = queueRegistry.getQueue(QueueName.DEAD_LETTER);

  const workerOrchestrator = new WorkerOrchestrator({
    processorRegistry,
    redisFactory,
    dlqQueue,
    idempotencyStore,
    distributedLock,
  });

  const transactionQueueService = new TransactionQueueService(queueRegistry);
  const queueMonitor            = new QueueMonitor(queueRegistry, redisFactory);

  // Register built-in processors
  processorRegistry.register(JobType.LEDGER_POST,      ledgerPostProcessor);
  processorRegistry.register(JobType.PAYMENT_INITIATE, paymentProcessor);
  processorRegistry.register(JobType.FRAUD_CHECK,      fraudCheckProcessor);
  processorRegistry.register(JobType.NOTIFY_EMAIL,     notifyEmailProcessor);

  /**
   * Start all workers with appropriate concurrency settings.
   * Critical queues get lower concurrency (more careful) but highest priority.
   * Batch queues get higher concurrency (throughput over latency).
   */
  const startWorkers = () => {
    workerOrchestrator.startWorker(QueueName.CRITICAL,     { concurrency: 3 });
    workerOrchestrator.startWorker(QueueName.LEDGER,       { concurrency: 10 });
    workerOrchestrator.startWorker(QueueName.COMPLIANCE,   { concurrency: 5 });
    workerOrchestrator.startWorker(QueueName.INVOICING,    { concurrency: 5 });
    workerOrchestrator.startWorker(QueueName.NOTIFICATION, { concurrency: 20 });
    workerOrchestrator.startWorker(QueueName.BATCH,        { concurrency: 3 });
    workerOrchestrator.startWorker(QueueName.AUDIT,        { concurrency: 10 });

    // Attach event monitors
    Object.values(QueueName).forEach(n => queueMonitor.attachQueueEvents(n));
    logger.info('[TransactionProcessor] All workers started');
  };

  /**
   * Graceful shutdown — called on SIGTERM/SIGINT.
   */
  const shutdown = async () => {
    await workerOrchestrator.shutdown();
    await queueRegistry.closeAll();
    await sharedRedis.quit();
    await redisFactory.closeAll();
    logger.info('[TransactionProcessor] Shutdown complete');
  };

  // Register system signal handlers
  process.once('SIGTERM', shutdown);
  process.once('SIGINT',  shutdown);

  return {
    // Public API
    transactionQueueService,
    processorRegistry,
    queueRegistry,
    workerOrchestrator,
    queueMonitor,
    // Lifecycle
    startWorkers,
    shutdown,
    // Utilities (for testing)
    idempotencyStore,
    distributedLock,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE USAGE
// ─────────────────────────────────────────────────────────────────────────────

async function runTransactionProcessorExample() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Transaction Processor Engine — Example Workflow');
  console.log('═══════════════════════════════════════════════════\n');

  // NOTE: This example uses a mock Redis — replace with real ioredis config in production
  console.log('NOTE: Full execution requires a running Redis instance.');
  console.log('      Demonstrating API surface and job construction below.\n');

  // Simulate what the system looks like when wired up
  const mockQueueService = {
    enqueue: async (jobType, payload, options) => {
      console.log(`[ENQUEUE] ${jobType}`);
      console.log(`  Payload:  ${JSON.stringify({ ...payload, idempotencyKey: undefined }).slice(0, 80)}...`);
      console.log(`  Priority: ${options?.priority || Priority.NORMAL}`);
      console.log(`  Key:      ${options?.idempotencyKey || '(auto)'}\n`);
      return { jobId: uuidv4().slice(0,8), status: ProcessingStatus.QUEUED };
    },
    enqueueBatch: async (jobs) => {
      console.log(`[BATCH ENQUEUE] ${jobs.length} jobs`);
      jobs.forEach(j => console.log(`  - ${j.jobType}`));
      console.log();
      return jobs.map(() => ({ jobId: uuidv4().slice(0,8), status: ProcessingStatus.QUEUED }));
    },
  };

  // 1. Enqueue a payment
  await mockQueueService.enqueue(JobType.PAYMENT_INITIATE, {
    fromAccountId:  'acc-001',
    toAccountId:    'acc-002',
    amount:         '5000.00',
    currency:       'USD',
    reference:      'PAY-2024-001',
    traceId:        uuidv4(),
  }, { priority: Priority.CRITICAL, idempotencyKey: 'pay-2024-001' });

  // 2. Enqueue a ledger post
  await mockQueueService.enqueue(JobType.LEDGER_POST, {
    transactionId: uuidv4(),
    reference:     'INV-2024-001',
    entries: [
      { accountId: 'cash-001',    entryType: 'DEBIT',  amount: '5000' },
      { accountId: 'revenue-001', entryType: 'CREDIT', amount: '5000' },
    ],
  }, { priority: Priority.HIGH });

  // 3. Batch enqueue notifications
  await mockQueueService.enqueueBatch([
    { jobType: JobType.NOTIFY_EMAIL,   payload: { to: 'user@example.com', subject: 'Payment Sent', templateId: 'payment-sent' } },
    { jobType: JobType.NOTIFY_SMS,     payload: { phone: '+1234567890', message: 'Your payment of $5,000 was sent' } },
    { jobType: JobType.NOTIFY_WEBHOOK, payload: { url: 'https://hooks.example.com/pay', event: 'payment.sent', data: {} } },
  ]);

  // 4. Enqueue a delayed fraud check (after 5 seconds)
  await mockQueueService.enqueue(JobType.FRAUD_CHECK, {
    transactionId: 'txn-001',
    amount:        '5000.00',
    fromAccountId: 'acc-001',
  }, { delayMs: 5000, priority: Priority.HIGH });

  // 5. Show job type routing
  console.log('── Queue Routing Map ─────────────────────────────');
  const routingExamples = [
    [JobType.PAYMENT_INITIATE,     Priority.CRITICAL],
    [JobType.LEDGER_POST,          Priority.HIGH],
    [JobType.FRAUD_CHECK,          Priority.HIGH],
    [JobType.INVOICE_GENERATE,     Priority.NORMAL],
    [JobType.NOTIFY_EMAIL,         Priority.LOW],
    [JobType.RECONCILIATION_BATCH, Priority.BATCH],
  ];
  routingExamples.forEach(([type, pri]) => {
    console.log(`  ${type.padEnd(30)} → priority=${pri}`);
  });

  // 6. Show metrics
  console.log('\n── Processor Metrics ─────────────────────────────');
  MetricsCollector.record(JobType.LEDGER_POST,      'success',           12);
  MetricsCollector.record(JobType.PAYMENT_INITIATE, 'success',           85);
  MetricsCollector.record(JobType.FRAUD_CHECK,      'success',           45);
  MetricsCollector.record(JobType.FRAUD_CHECK,      'failed_transient',  120);
  const metrics = MetricsCollector.getMetrics();
  for (const [key, val] of Object.entries(metrics)) {
    console.log(`  ${key.padEnd(40)} count=${val.count} avg=${val.avgMs}ms max=${val.maxMs}ms`);
  }

  console.log('\n═══════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Factory
  createTransactionProcessor,
  // Application services
  TransactionQueueService,
  WorkerOrchestrator,
  QueueMonitor,
  // Domain
  ProcessorRegistry,
  QueueRegistry,
  MiddlewarePipeline,
  // Infrastructure
  RedisConnectionFactory,
  IdempotencyStore,
  DistributedLock,
  // Middlewares
  validationMiddleware,
  loggingMiddleware,
  metricsMiddleware,
  retryStrategyMiddleware,
  createIdempotencyMiddleware,
  // Processors
  ledgerPostProcessor,
  paymentProcessor,
  fraudCheckProcessor,
  notifyEmailProcessor,
  // Validation
  JobPayloadValidator,
  // Metrics
  MetricsCollector,
  // Enums
  JobType,
  QueueName,
  Priority,
  ProcessingStatus,
  // Errors
  ProcessorError,
  DuplicateJobError,
  ValidationError,
  InsufficientFundsError,
  TransientError,
  // Example
  runTransactionProcessorExample,
};

if (require.main === module) {
  runTransactionProcessorExample().catch(err => {
    console.error('Example failed:', err);
    process.exit(1);
  });
}