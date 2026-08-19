// routes/health.route.js

const express     = require('express');
const router      = express.Router();
const pool        = require('../config/db.config');       // your pg Pool instance
const redisClient = require('../config/redis.config');
const { catchAsync } = require('../middlewares/errorHandler.middleware');

const START_TIME = Date.now();

// ─────────────────────────────────────────────
// GET /health
// Full health check — DB + Redis + process stats
// ─────────────────────────────────────────────
router.get('/', catchAsync(async (req, res) => {
  const checks = await Promise.allSettled([
    pool.query('SELECT 1'),
    redisClient.ping(),
  ]);

  const pgOk    = checks[0].status === 'fulfilled';
  const redisOk = checks[1].status === 'fulfilled';
  const healthy = pgOk && redisOk;

  const uptimeMs = Date.now() - START_TIME;

  const payload = {
    status:    healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: {
      process: formatUptime(process.uptime()),   // Node process uptime
      server:  formatUptime(uptimeMs / 1000),    // Since this module was loaded
    },
    services: {
      postgres: {
        status: pgOk ? 'up' : 'down',
        ...(!pgOk && { error: checks[0].reason?.message }),
      },
      redis: {
        status: redisOk ? 'up' : 'down',
        ...(!redisOk && { error: checks[1].reason?.message }),
      },
    },
    process: {
      memoryMb: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      node:     process.version,
      env:      process.env.NODE_ENV,
      pid:      process.pid,
    },
  };

  // 503 so load balancers stop routing to this instance if degraded
  res.status(healthy ? 200 : 503).json(payload);
}));

// ─────────────────────────────────────────────
// GET /health/live
// Liveness — just confirms the process is alive.
// Kubernetes uses this; if it fails, the pod restarts.
// ─────────────────────────────────────────────
router.get('/live', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─────────────────────────────────────────────
// GET /health/ready
// Readiness — confirms the app can serve traffic.
// Kubernetes uses this; if it fails, traffic is paused.
// ─────────────────────────────────────────────
router.get('/ready', catchAsync(async (req, res) => {
  // Only check DB; Redis failure shouldn't block readiness
  await pool.query('SELECT 1');
  res.status(200).json({ status: 'ready' });
}));

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

module.exports = router;

// ─────────────────────────────────────────────
// Usage in app.js:
//
// const healthRouter = require('./routes/health.route');
// app.use('/health', healthRouter);
//
// Endpoints:
//   GET /health        → full status (postgres, redis, memory)
//   GET /health/live   → liveness probe
//   GET /health/ready  → readiness probe
// ─────────────────────────────────────────────