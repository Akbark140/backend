require('dotenv').config()
const http = require('http');
const app = require('./src/app');
const { config } = require('./src/config/index.config');
const { disconnectRedis } = require('./src/config/redis.config');
const { query } = require('./src/config/db.config');
const { registerProcessHandlers } = require('./src/middleware/errorHandler.middleware');
const { startInsightsCron } = require('./src/modules/ai/ai.cron')
const { initCronJobs } = require('./src/config/cron.config');

const server = http.createServer(app);
const PORT = Number(config.PORT) || 4000;

async function start() {
  try {
    // ── Connect Database ──────────────────────
    // ── Connect Database ──────────────────────
    await (async () => {
      await query('SELECT 1');
      console.log('✅ Database connected');
    })();

    // ── Connect Redis ─────────────────────────
    // await connectRedis();

    // ── Start Server ──────────────────────────
    server.listen(PORT, () => {
      console.log('────────────────────────────────────');
      console.log(`🚀 Server Started Successfully`);
      console.log(`🌍 Environment : ${config.NODE_ENV}`);
      console.log(`🔗 Port        : ${PORT}`);
      console.log(`📡 URL         : http://localhost:${PORT}`);
      console.log('────────────────────────────────────');
      initCronJobs();
    });

    registerProcessHandlers(server);

  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
}

start();

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
  server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await disconnectRedis();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await disconnectRedis();
  process.exit(0);
});

startInsightsCron();
