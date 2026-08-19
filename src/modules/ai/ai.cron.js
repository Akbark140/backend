'use strict';

// src/modules/ai/ai.cron.js
//
// Scheduled jobs for the AI engine.
//
// What changed from the original
// ────────────────────────────────
// BEFORE: cron → generateInsightsSummary (Ollama, synchronous) → sendEmail
//         Problem: if Ollama is slow or a user errors, the entire loop stalls.
//         A Monday-morning restart meant emails for some users were never sent.
//
// NOW:    cron → enqueueWeeklyInsights (BullMQ, <1 ms per user) → worker picks up
//         Benefits:
//           • Cron finishes in seconds regardless of user count
//           • Deterministic jobId = no duplicate emails if cron fires twice
//           • Failed jobs are retried automatically (3×, exponential backoff)
//           • Worker and cron are decoupled — cron can restart without losing jobs
//           • The 2-second delay between users is gone; BullMQ concurrency handles pacing

const cron    = require('node-cron');
const { logger }  = require('../../config/logger.config');
const {
  enqueueWeeklyInsights,
} = require('./ai.queue');
const {
  getAllUsersWithEmail,
} = require('../reports/reports.repository');

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS (identical logic to original, kept for parity)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Monday–Sunday date range for the week that is `weeksAgo` weeks
 * before the current week.
 *
 * @param {number} weeksAgo - 0 = current week, 1 = last week
 * @returns {{ start: string, end: string }}  ISO date strings (YYYY-MM-DD)
 */
function getDateRange(weeksAgo = 0) {
  const now          = new Date();
  const day          = now.getDay();                         // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday - weeksAgo * 7);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return {
    start: monday.toISOString().split('T')[0],
    end:   sunday.toISOString().split('T')[0],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN JOB DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all users and enqueues one weekly-insights job per user.
 *
 * The actual AI generation + email delivery happens inside ai.worker.js.
 * This function only enqueues — it completes in milliseconds regardless of
 * how many users exist.
 *
 * Safe to call multiple times for the same week: BullMQ deduplicates by jobId
 * (`weekly:{userId}:{thisWeekStart}`), so no user receives duplicate emails.
 */
async function runWeeklyInsights() {
  logger.info('[AICron] Weekly insights dispatcher starting...');

  const thisWeek = getDateRange(0);
  const lastWeek = getDateRange(1);

  let users;
  try {
    users = await getAllUsersWithEmail();
  } catch (err) {
    logger.error({ err: err.message }, '[AICron] Failed to load users — weekly insights aborted.');
    return;
  }

  if (!users || users.length === 0) {
    logger.info('[AICron] No users found. Weekly insights skipped.');
    return;
  }

  let enqueued = 0;
  let skipped  = 0;

  for (const user of users) {
    if (!user?.id || !user?.email) {
      skipped++;
      continue;
    }

    try {
      const { jobId } = await enqueueWeeklyInsights(
        user.id,
        user.email,
        user.name ?? user.email,
        thisWeek.start,
        thisWeek.end,
        lastWeek.start,
        lastWeek.end,
      );
      logger.debug({ jobId, userId: user.id }, '[AICron] Job enqueued.');
      enqueued++;
    } catch (err) {
      // Log but don't abort — continue for remaining users
      logger.error(
        { err: err.message, userId: user.id },
        '[AICron] Failed to enqueue weekly insights job.',
      );
      skipped++;
    }
  }

  logger.info(
    { enqueued, skipped, week: thisWeek.start },
    '[AICron] Weekly insights dispatch complete.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers the weekly cron schedule.
 * Call once at application startup (e.g. in server.js after DB is ready).
 *
 * Schedule: every Monday at 9:00 AM Asia/Karachi
 */
function startInsightsCron() {
  cron.schedule('0 9 * * 1', runWeeklyInsights, {
    timezone: 'Asia/Karachi',
  });

  logger.info('[AICron] Weekly insights cron scheduled — runs every Monday at 09:00 Asia/Karachi.');
}

module.exports = { 
  startInsightsCron, 
  runWeeklyInsights 
};