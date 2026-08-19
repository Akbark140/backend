'use strict';

/**
 * @module ai/ai.gateway
 * @description Production-grade AI Gateway Layer — the single chokepoint for
 * all calls to any external AI model.
 *
 * Implements:
 *  - Exponential-backoff retry for transient errors (503, UNAVAILABLE, fetch failed)
 *  - Per-call timeout (default 30 s for non-streaming, 60 s for streaming)
 *  - Circuit breaker (CLOSED → OPEN → HALF-OPEN) via in-process state
 *  - Automatic model fallback (primary → secondary)
 *  - Structured logging on every attempt, failure, and recovery
 *
 * Circuit-breaker state machine
 * ──────────────────────────────
 *  CLOSED     → normal operation; failures are counted
 *  OPEN       → fast-fail; no calls reach the model; resets after RESET_TIMEOUT_MS
 *  HALF-OPEN  → one probe request allowed; success → CLOSED, failure → OPEN again
 */

const { GoogleGenAI } = require('@google/genai');
const { logger }      = require('../../config/logger.config');

// ─── SDK instance ─────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  logger.warn('[AIGateway] GEMINI_API_KEY is missing — AI calls will fail.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Model roster (ordered: primary → fallback) ───────────────────────────────
const MODELS = ['gemini-2.5-flash', 'gemini-1.5-flash'];

// ─── Circuit-breaker config ───────────────────────────────────────────────────
const CB_FAILURE_THRESHOLD  = 5;        // consecutive failures to OPEN circuit
const CB_RESET_TIMEOUT_MS   = 60_000;   // time in OPEN before moving to HALF-OPEN
const CB_HALF_OPEN_PROBES   = 1;        // requests allowed in HALF-OPEN

// ─── In-process circuit-breaker state (one per Gateway instance) ──────────────
const circuitBreaker = {
  state:            'CLOSED',  // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  failureCount:     0,
  lastFailureTime:  null,
  halfOpenProbes:   0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Determines whether an error is a transient/retriable AI-provider failure. */
function isRetriable(err) {
  if (!err) return false;
  const code    = err?.code    ?? '';
  const status  = err?.status  ?? '';
  const message = String(err?.message ?? '').toLowerCase();
  return (
    code === 503          ||
    status === 'UNAVAILABLE' ||
    message.includes('unavailable') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('etimedout')
  );
}

/** Wraps a Promise with a hard timeout. */
function withTimeout(promise, ms, label = 'AI call') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`[AIGateway] Timeout after ${ms}ms: ${label}`)),
        ms,
      ),
    ),
  ]);
}

/** Records a failure in the circuit breaker, opening the circuit if threshold met. */
function recordFailure() {
  circuitBreaker.failureCount   += 1;
  circuitBreaker.lastFailureTime = Date.now();

  if (circuitBreaker.failureCount >= CB_FAILURE_THRESHOLD) {
    circuitBreaker.state = 'OPEN';
    logger.error(
      { failureCount: circuitBreaker.failureCount },
      '[AIGateway] Circuit OPENED — AI calls will fast-fail until recovery probe succeeds.',
    );
  }
}

/** Records a success, resetting the circuit breaker to CLOSED. */
function recordSuccess() {
  if (circuitBreaker.state !== 'CLOSED') {
    logger.info('[AIGateway] Circuit CLOSED — AI service recovered.');
  }
  circuitBreaker.state        = 'CLOSED';
  circuitBreaker.failureCount = 0;
  circuitBreaker.halfOpenProbes = 0;
}

/**
 * Checks the circuit breaker state and throws if OPEN.
 * Transitions OPEN → HALF_OPEN when reset timeout elapses.
 */
function checkCircuit() {
  if (circuitBreaker.state === 'CLOSED') return;

  if (circuitBreaker.state === 'OPEN') {
    const elapsed = Date.now() - circuitBreaker.lastFailureTime;
    if (elapsed >= CB_RESET_TIMEOUT_MS) {
      circuitBreaker.state = 'HALF_OPEN';
      circuitBreaker.halfOpenProbes = 0;
      logger.info('[AIGateway] Circuit → HALF_OPEN, sending probe request.');
      return; // allow probe through
    }
    const waitSec = Math.ceil((CB_RESET_TIMEOUT_MS - elapsed) / 1000);
    throw Object.assign(
      new Error(`AI service circuit is OPEN. Retry in ${waitSec}s.`),
      { code: 503, isCircuitOpen: true },
    );
  }

  // HALF_OPEN — allow only the configured number of probes
  if (circuitBreaker.halfOpenProbes >= CB_HALF_OPEN_PROBES) {
    throw Object.assign(
      new Error('AI service circuit is HALF_OPEN. Waiting for probe result.'),
      { code: 503, isCircuitOpen: true },
    );
  }
  circuitBreaker.halfOpenProbes += 1;
}

// ─── Core gateway function ────────────────────────────────────────────────────

/**
 * Executes an AI SDK call through the full resilience pipeline.
 *
 * @param {Function} sdkCallFn  - `(model: string) => Promise<any>` factory.
 *                                Receives the active model name so the caller
 *                                can construct its SDK call per-model.
 * @param {Object}  [opts]
 * @param {number}  [opts.retries=3]        - Max attempts per model.
 * @param {number}  [opts.timeoutMs=30000]  - Per-attempt hard timeout.
 * @param {string}  [opts.label='']         - Log label for this operation.
 * @returns {Promise<any>}
 */
async function call(sdkCallFn, opts = {}) {
  const {
    retries   = 3,
    timeoutMs = 30_000,
    label     = 'ai-call',
  } = opts;

  checkCircuit(); // fast-fail if circuit is open

  let lastError;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await withTimeout(
          sdkCallFn(model, ai),
          timeoutMs,
          `${label}[model=${model},attempt=${attempt + 1}]`,
        );
        recordSuccess();
        return result;
      } catch (err) {
        lastError = err;

        const retriable = isRetriable(err);
        const delayMs   = Math.pow(2, attempt) * 1_000; // 1 s → 2 s → 4 s

        logger.warn(
          {
            label,
            model,
            attempt: attempt + 1,
            retriable,
            delayMs: retriable ? delayMs : null,
            errMessage: err?.message,
          },
          `[AIGateway] ${retriable ? 'Retriable' : 'Non-retriable'} error on attempt ${attempt + 1}/${retries}.`,
        );

        if (!retriable) {
          // Non-retriable: skip remaining attempts for this model, try fallback
          break;
        }

        recordFailure();

        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    logger.warn({ label, model }, `[AIGateway] All retries exhausted for model "${model}". Trying next model.`);
  }

  // All models and retries exhausted
  recordFailure();
  logger.error({ label, err: lastError?.message }, '[AIGateway] All models failed — propagating error.');
  throw lastError;
}

/**
 * Variant of `call` for streaming operations.
 * Returns the async iterable stream; the caller must consume it.
 * Circuit-breaker and single-attempt timeout still apply.
 *
 * @param {Function} sdkStreamFn - `(model: string, ai: GoogleGenAI) => Promise<AsyncIterable>`
 * @param {Object}  [opts]
 * @param {number}  [opts.timeoutMs=60000]  - Timeout for the initial stream handshake.
 * @param {string}  [opts.label='']
 * @returns {Promise<AsyncIterable>}
 */
async function stream(sdkStreamFn, opts = {}) {
  const {
    timeoutMs = 60_000,
    label     = 'ai-stream',
    retries   = 3,
  } = opts;

  checkCircuit();

  let lastError;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await withTimeout(
          sdkStreamFn(model, ai),
          timeoutMs,
          `${label}[model=${model},attempt=${attempt + 1}]`,
        );
        recordSuccess();
        return result;
      } catch (err) {
        lastError = err;
        const retriable = isRetriable(err);
        const delayMs   = Math.pow(2, attempt) * 1_000;

        logger.warn(
          { label, model, attempt: attempt + 1, retriable, errMessage: err?.message },
          `[AIGateway] Stream error on attempt ${attempt + 1}/${retries}.`,
        );

        if (!retriable) break;
        recordFailure();
        if (attempt < retries - 1) await new Promise(r => setTimeout(r, delayMs));
      }
    }
    logger.warn({ label, model }, `[AIGateway] Stream retries exhausted for "${model}". Trying fallback.`);
  }

  recordFailure();
  throw lastError;
}

/** Returns current circuit-breaker state for health-check endpoints. */
function getCircuitStatus() {
  return {
    state:        circuitBreaker.state,
    failureCount: circuitBreaker.failureCount,
    lastFailure:  circuitBreaker.lastFailureTime
      ? new Date(circuitBreaker.lastFailureTime).toISOString()
      : null,
  };
}

module.exports = { call, stream, getCircuitStatus, MODELS };