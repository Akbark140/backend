// db.config.js
const { Pool } = require('pg');
const { config } = require('./index.config');
const { logger } = require('./logger.config');

const isProduction = config.NODE_ENV === 'production';

// ── SSL configuration ─────────────────────────────────────────────────────────
let sslConfig = false;

if (isProduction) {
  if (config.DB_SSL_CERT) {
    sslConfig = { rejectUnauthorized: true, ca: config.DB_SSL_CERT };
  } else if (config.ALLOW_INSECURE_DB === 'true') {
    logger.warn(
      'DB SSL certificate validation is disabled (ALLOW_INSECURE_DB=true). ' +
      'This should never be used in production unless absolutely necessary.'
    );
    sslConfig = { rejectUnauthorized: false };
  } else {
    const msg =
      'CRITICAL SECURITY ERROR: Production database requires DB_SSL_CERT. ' +
      'Set DB_SSL_CERT or explicitly set ALLOW_INSECURE_DB=true to override (not recommended).';
    logger.fatal(msg);
    throw new Error(msg);
  }
}

// ── Environment helpers ───────────────────────────────────────────────────────
// parseInt('') and parseInt(undefined) both return NaN — this guard ensures
// invalid or missing env vars fall back to safe defaults instead of breaking
// the Pool config silently.
const parseEnvInt = (val, fallback) => {
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
};

// ── Pool ──────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl:              sslConfig,

  // Visible in pg_stat_activity — invaluable during incident debugging
  application_name: config.APP_NAME || 'app',

  max:                     parseEnvInt(config.DB_POOL_MAX,          10),
  idleTimeoutMillis:       parseEnvInt(config.DB_IDLE_TIMEOUT,   30000),
  // 5s default guards against aggressive restart loops on DB cold starts
  connectionTimeoutMillis: parseEnvInt(config.DB_CONN_TIMEOUT,    5000),
  // Kills runaway queries before they hold connections and starve the pool
  statement_timeout:       parseEnvInt(config.DB_STATEMENT_TIMEOUT, 30000),
  // Kills sessions idle inside a transaction — prevents a forgotten BEGIN
  // from holding a connection open indefinitely
  idle_in_transaction_session_timeout: parseEnvInt(config.DB_IDLE_TX_TIMEOUT, 60000),
  // Recycles connections after N uses — prevents stale connections and
  // slow memory growth in long-lived processes (Render, Railway, K8s)
  maxUses: parseEnvInt(config.DB_MAX_USES, 7500),
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  // isShuttingDown prevents duplicate pool.end() calls — second signal
  // force-exits immediately rather than waiting for the drain to finish
  if (isShuttingDown) {
    logger.warn('Forcing immediate shutdown due to multiple signals...');
    process.exit(1);
  }

  isShuttingDown = true;
  logger.warn({ signal }, 'Received signal — draining database pool...');

  // Safety net: if the pool doesn't drain within 10s (e.g. a hung transaction),
  // force exit so the orchestrator can restart rather than hanging forever
  const forceExit = setTimeout(() => {
    logger.error('Database pool did not drain in time — forcing exit');
    process.exit(1);
  }, 10_000);

  // unref() prevents this timer from keeping the process alive if everything
  // else has already exited cleanly
  forceExit.unref();

  try {
    await pool.end();
    logger.info('Database pool closed gracefully');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error closing database pool during shutdown');
    process.exit(1);
  }
}

// process.once for SIGTERM — orchestrator termination never needs double-fire
// process.on  for SIGINT  — retains double Ctrl+C force-exit during local dev
// isShuttingDown guard above prevents duplicate execution in both cases
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',    () => gracefulShutdown('SIGINT'));

// ── Startup connection check ──────────────────────────────────────────────────
// Skipped in test environments — no real DB connections during unit tests.
// Intentionally a single probe, not a retry loop. Retry/backoff belongs in
// the orchestration layer (K8s initialDelaySeconds, Compose healthcheck, etc.)
// so failures are visible to the platform rather than hidden inside the app.
if (config.NODE_ENV !== 'test') {
  (async () => {
    try {
      const client = await pool.connect();
      logger.info('Database connected successfully');
      client.release();
    } catch (err) {
      logger.error(
        { err },
        'Database connection failed on startup — DB operations will fail until connection is restored'
      );

      if (config.DB_FAIL_FAST === 'true') {
        logger.fatal('DB_FAIL_FAST is enabled — crashing process to allow orchestrator recovery...');
        // 150ms window lets pino flush the fatal log to stdout before process dies
        setTimeout(() => process.exit(1), 150).unref();
      }
    }
  })();
}

// ── Query helper ──────────────────────────────────────────────────────────────
// Accepts either a plain SQL string or a named query object:
//   query('SELECT * FROM users WHERE id=$1', [id])
//   query({ name: 'get-user-by-id', text: 'SELECT ...', values: [id] })
//
// Named queries use pg's prepared statement cache — logs show the query name
// instead of raw SQL, which is cleaner in production log collectors.
//
// query_text / query_name are excluded from production error logs to prevent
// sensitive data embedded in SQL strings from leaking into log collectors.
async function query(textOrConfig, params) {
  const start     = Date.now();
  const queryName = typeof textOrConfig === 'object' ? textOrConfig.name : undefined;
  const queryText = typeof textOrConfig === 'object' ? textOrConfig.text : textOrConfig;

  try {
    const result   = await pool.query(textOrConfig, params);
    const duration = Date.now() - start;

    const meta = {
      duration_ms: duration,
      rows: result.rowCount,
      ...(isProduction ? {} : { query_name: queryName, query_text: queryText }),
    };

    // Slow query warning — surfaces N+1 patterns and missing indexes
    if (duration > 1000) {
      logger.warn(meta, 'Slow query detected');
    } else {
      logger.debug(meta, 'Query executed');
    }

    return result;
  } catch (err) {
    logger.error(
      {
        err,
        duration_ms: Date.now() - start,
        ...(isProduction ? {} : { query_name: queryName, query_text: queryText }),
      },
      'Query failed'
    );
    throw err;
  }
}

// ── Transaction helper ────────────────────────────────────────────────────────
// The callback receives a `tx` proxy that exposes only `query` — this prevents
// accidental client.release() or client.end() calls from service-layer code,
// which would corrupt the pool state silently.
//
// txStarted / txCommitted flags prevent a pointless ROLLBACK attempt if BEGIN
// itself never succeeded, avoiding unnecessary noise in the logs.
async function withTransaction(callback) {
  const client    = await pool.connect();
  let txStarted   = false;
  let txCommitted = false;
  const start     = Date.now();

  // Expose only query() to the callback — callers cannot release or end
  // the client directly, preventing accidental pool corruption
  const tx = {
    query: (...args) => client.query(...args),
  };

  try {
    await client.query('BEGIN');
    txStarted = true;

    const result = await callback(tx);

    await client.query('COMMIT');
    txCommitted = true;

    logger.debug({ duration_ms: Date.now() - start }, 'Transaction committed');
    return result;
  } catch (err) {
    logger.error(
      { err, duration_ms: Date.now() - start },
      'Transaction failed'
    );

    if (txStarted && !txCommitted) {
      try {
        await client.query('ROLLBACK');
        logger.warn('Transaction rolled back successfully');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, 'ROLLBACK failed');
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
// Hits the pool directly — bypasses query() to avoid double-logging failures
// and to suppress debug timing noise on every Kubernetes readiness probe tick.
// statement_timeout on the pool already caps how long SELECT 1 can hang.
async function ping() {
  try {
    const result = await pool.query('SELECT 1');
    return result.rowCount === 1;
  } catch (err) {
    logger.error({ err }, 'Database ping failed');
    return false;
  }
}

// ── Pool metrics ──────────────────────────────────────────────────────────────
// Exposes connection counts for health/readiness endpoints without leaking
// the raw pool object or its internal methods.
function getPoolStats() {
  return {
    total:   pool.totalCount,
    idle:    pool.idleCount,
    waiting: pool.waitingCount,
  };
}

// ── Pool teardown (for tests) ─────────────────────────────────────────────────
// Drains all connections so Jest (or other test runners) can exit cleanly.
async function closePool() {
  await pool.end();
}

// pool is intentionally not exported — all access goes through the helpers
// above to keep connection handling centralised and auditable.
// For advanced Postgres features (LISTEN/NOTIFY, COPY, cursors), add a
// dedicated helper here rather than exporting pool raw.
module.exports = { 
  query, 
  withTransaction, 
  ping, 
  getPoolStats,
  closePool,
};