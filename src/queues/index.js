// queues/index.js
//
// BullMQ — job queues backed by Redis.
// Install: npm install bullmq
//
// This file exports pre-built queues.
// Workers live in queues/workers/ and run in a separate process.

const { Queue } = require('bullmq');
const redisClient = require('../config/redis.config');

// Shared connection options pulled from your existing Redis client config
const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Default job options applied to every queue unless overridden per-job
const defaultJobOptions = {
  attempts:  3,
  backoff: {
    type:  'exponential',
    delay: 2000, // 2s, 4s, 8s
  },
  removeOnComplete: { count: 100 }, // keep last 100 completed jobs
  removeOnFail:     { count: 200 }, // keep last 200 failed jobs for inspection
};

// ─────────────────────────────────────────────
// Queues
// ─────────────────────────────────────────────
const emailQueue = new Queue('emails', {
  connection,
  defaultJobOptions,
});

const notificationQueue = new Queue('notifications', {
  connection,
  defaultJobOptions,
});

const reportQueue = new Queue('reports', {
  connection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 }, // reports don't retry
});

module.exports = { emailQueue, notificationQueue, reportQueue };