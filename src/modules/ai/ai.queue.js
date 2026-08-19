'use strict';

/**
 * @module ai/ai.queue
 * @description BullMQ queue and job-type registry for all async AI operations.
 *
 * Why queues for AI?
 * ──────────────────
 * External AI APIs (Gemini, Claude, etc.) have unpredictable latency (2–30 s),
 * rate limits, and occasional outages.  Calling them synchronously from an HTTP
 * handler produces timeouts, poor UX, and fragile retry logic.
 *
 * Instead, every non-streaming AI operation is enqueued here.  The HTTP handler
 * returns a jobId immediately (<5 ms).  The client polls GET /api/ai/jobs/:id
 * or receives a WebSocket push when the result is ready.
 *
 * Queue names
 * ───────────
 *  ai:insights      — monthly spending insights + budget recommendations
 *  ai:categorize    — batch transaction auto-categorization
 *  ai:analyze       — on-demand financial analysis
 *  ai:suggest       — savings optimisation suggestions
 *  ai:report        — PDF/Excel report generation
 *
 * All queues share one Redis connection.
 * Workers are defined in workers/ai.worker.js.
 */

const { Queue, QueueEvents } = require('bullmq');
const { logger }             = require('../../config/logger.config');

// ─── Redis connection options ─────────────────────────────────────────────────
// Reuse the existing Redis config if available, otherwise read env directly.
let redisConnection;
try {
  const redisConfig = require('../../config/redis.config');
  redisConnection   = redisConfig.connectionOptions ?? redisConfig;
} catch {
  redisConnection = {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null, // required by BullMQ
  };
}

// ─── Queue names ──────────────────────────────────────────────────────────────
const QUEUE_NAMES = {
  INSIGHTS:   'ai:insights',
  CATEGORIZE: 'ai:categorize',
  ANALYZE:    'ai:analyze',
  SUGGEST:    'ai:suggest',
  REPORT:     'ai:report',
};

// ─── Default job options ──────────────────────────────────────────────────────
const DEFAULT_JOB_OPTIONS = {
  attempts:       3,
  backoff:        { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 500 },   // keep last 500 completed jobs
  removeOnFail:     { count: 200 },   // keep last 200 failed jobs for inspection
};

// ─── Queue factory (lazy, cached) ─────────────────────────────────────────────
const _queues       = new Map();
const _queueEvents  = new Map();

/**
 * Returns (or lazily creates) the BullMQ Queue for the given name.
 * @param {string} name - One of QUEUE_NAMES values.
 * @returns {Queue}
 */
function getQueue(name) {
  if (!_queues.has(name)) {
    const q = new Queue(name, {
      connection:   redisConnection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    q.on('error', (err) =>
      logger.error({ queue: name, err: err.message }, '[AIQueue] Queue error'),
    );

    _queues.set(name, q);
    logger.info({ queue: name }, '[AIQueue] Queue initialised.');
  }
  return _queues.get(name);
}

/**
 * Returns (or lazily creates) the QueueEvents listener for the given queue.
 * Used by the job-status polling endpoint to await completion.
 * @param {string} name
 * @returns {QueueEvents}
 */
function getQueueEvents(name) {
  if (!_queueEvents.has(name)) {
    const qe = new QueueEvents(name, { connection: redisConnection });
    qe.on('error', (err) =>
      logger.error({ queue: name, err: err.message }, '[AIQueue] QueueEvents error'),
    );
    _queueEvents.set(name, qe);
  }
  return _queueEvents.get(name);
}

// ─── Public enqueue helpers ───────────────────────────────────────────────────

/**
 * Enqueues a monthly spending-insights generation job.
 *
 * @param {string} userId
 * @param {number} month  - 1-12
 * @param {number} year
 * @param {object} [opts] - BullMQ job options override
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueInsights(userId, month, year, opts = {}) {
  const queue = getQueue(QUEUE_NAMES.INSIGHTS);
  const job   = await queue.add(
    'generate-insights',
    { userId, month, year },
    { ...DEFAULT_JOB_OPTIONS, ...opts, jobId: `insights:${userId}:${year}-${String(month).padStart(2,'0')}` },
  );
  logger.info({ jobId: job.id, userId, month, year }, '[AIQueue] Insights job enqueued.');
  return { jobId: job.id };
}

/**
 * Enqueues a batch transaction auto-categorization job.
 *
 * @param {string}   userId
 * @param {string[]} transactionIds
 * @param {object}   [opts]
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueCategorize(userId, transactionIds, opts = {}) {
  const queue = getQueue(QUEUE_NAMES.CATEGORIZE);
  const job   = await queue.add(
    'batch-categorize',
    { userId, transactionIds },
    { ...DEFAULT_JOB_OPTIONS, ...opts },
  );
  logger.info({ jobId: job.id, userId, count: transactionIds.length }, '[AIQueue] Categorize job enqueued.');
  return { jobId: job.id };
}

/**
 * Enqueues an on-demand financial analysis job.
 *
 * @param {string} userId
 * @param {object} payload - { startDate, endDate, promptContext }
 * @param {object} [opts]
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueAnalyze(userId, payload, opts = {}) {
  const queue = getQueue(QUEUE_NAMES.ANALYZE);
  const job   = await queue.add(
    'analyze',
    { userId, ...payload },
    { ...DEFAULT_JOB_OPTIONS, ...opts },
  );
  logger.info({ jobId: job.id, userId }, '[AIQueue] Analyze job enqueued.');
  return { jobId: job.id };
}

/**
 * Enqueues a savings-suggestion job.
 *
 * @param {string} userId
 * @param {object} payload - { promptContext }
 * @param {object} [opts]
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueSuggest(userId, payload, opts = {}) {
  const queue = getQueue(QUEUE_NAMES.SUGGEST);
  const job   = await queue.add(
    'suggest',
    { userId, ...payload },
    { ...DEFAULT_JOB_OPTIONS, ...opts },
  );
  logger.info({ jobId: job.id, userId }, '[AIQueue] Suggest job enqueued.');
  return { jobId: job.id };
}

/**
 * Enqueues a PDF/Excel report generation job.
 *
 * @param {string} userId
 * @param {string} month - 'YYYY-MM'
 * @param {object} [opts]
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueReport(userId, month, opts = {}) {
  const queue = getQueue(QUEUE_NAMES.REPORT);
  const job   = await queue.add(
    'generate-report',
    { userId, month },
    { ...DEFAULT_JOB_OPTIONS, priority: 5, ...opts },
  );
  logger.info({ jobId: job.id, userId, month }, '[AIQueue] Report job enqueued.');
  return { jobId: job.id };
}

/**
 * Returns the current status and result of any job across all queues.
 *
 * @param {string} jobId
 * @returns {Promise<{ status: string, result?: any, error?: string, progress?: number }>}
 */
async function getJobStatus(jobId) {
  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = getQueue(name);
    const job   = await queue.getJob(jobId);

    if (!job) continue;

    const state = await job.getState();

    return {
      jobId,
      queue:    name,
      status:   state,               // 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'
      progress: job.progress ?? 0,
      result:   state === 'completed' ? job.returnvalue : undefined,
      error:    state === 'failed'    ? job.failedReason : undefined,
      createdAt: new Date(job.timestamp).toISOString(),
    };
  }

  return { jobId, status: 'not_found' };
}

/**
 * Gracefully closes all open queues and queue-event listeners.
 * Call on process SIGTERM / SIGINT.
 */
async function closeAll() {
  const closes = [
    ...[..._queues.values()].map(q => q.close()),
    ...[..._queueEvents.values()].map(qe => qe.close()),
  ];
  await Promise.allSettled(closes);
  logger.info('[AIQueue] All queues closed.');
}

module.exports = {
  QUEUE_NAMES,
  getQueue,
  getQueueEvents,
  enqueueInsights,
  enqueueCategorize,
  enqueueAnalyze,
  enqueueSuggest,
  enqueueReport,
  getJobStatus,
  closeAll,
};