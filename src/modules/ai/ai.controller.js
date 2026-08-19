'use strict';



/**

 * @module ai/ai.controller

 * @description HTTP adapter for all AI endpoints.

 *

 * Architecture change (from previous version)

 * ────────────────────────────────────────────

 * BEFORE: every AI call was synchronous — controller called service, service

 *         called Gemini, user waited 5-30 s, occasional 503 timeouts crashed requests.

 *

 * NOW (per architecture plan §7, Decision 3):

 *   - POST /chat       → still streaming (real-time UX requirement)

 *   - POST /analyze    → enqueues job  → returns jobId (async)

 *   - POST /suggest    → enqueues job  → returns jobId (async)

 *   - GET  /jobs/:id   → poll job status + result

 *   - POST /insights/:month/:year → enqueues insights job

 *   - GET  /insights/history      → read from ai_insights table

 *   - GET  /circuit-status        → exposes circuit-breaker health

 *

 * Chat is kept synchronous/streaming because users expect real-time responses.

 * All other AI operations are fire-and-forget with polling.

 */



const aiService = require('./ai.service');

const aiQueue = require('./ai.queue');

const gateway = require('./ai.gateway');

const aiCache = require('./ai.cache');

const transactionService = require('../transactions/transactions.service');

const budgetService = require('../budgets/budget.service');

const { query } = require('../../config/db.config');

const { sendSuccess } = require('../../shared/ApiResponse');

const { logger } = require('../../config/logger.config');

const { AppError } = require('../../shared/AppError');

const { google } = require('googleapis');

const { config } = require('../../config/index.config');





// ─────────────────────────────────────────────────────────────────────────────

// HELPERS

// ─────────────────────────────────────────────────────────────────────────────



/** Safely extracts a flat transaction array from various service response shapes. */

function extractTransactions(raw) {

  if (!raw) return [];

  if (Array.isArray(raw)) return raw;

  if (Array.isArray(raw.data)) return raw.data;

  if (Array.isArray(raw.rows)) return raw.rows;

  if (Array.isArray(raw.transactions)) return raw.transactions;

  return [];

}



/** Builds the financial context string for the chat system prompt. */

function buildChatContext(transactions, budgets) {

  const income = transactions.filter(t => t.type === 'income')

    .reduce((a, t) => a + Number(t.amount || t.amount_in_base_currency || 0), 0);

  const expenses = transactions.filter(t => t.type === 'expense')

    .reduce((a, t) => a + Number(t.amount || t.amount_in_base_currency || 0), 0);



  const recentLines = transactions.slice(0, 8)

    .map(t => `- ${t.description ?? 'Transaction'} (${t.type}): ${t.amount || t.amount_in_base_currency || 0}`)

    .join('\n');



  const budgetLines = budgets

    .map(b => `- ${b.name ?? b.category}: Limit ${b.amountLimit || b.amount || 0}`)

    .join('\n');



  return `User's recent financial context:

Income this period:   ${income}

Expenses this period: ${expenses}

Recent transactions:

${recentLines}



Active Budgets:

${budgetLines || 'No active budgets.'}`;

}



// ─────────────────────────────────────────────────────────────────────────────

// 1. CHAT HISTORY

// ─────────────────────────────────────────────────────────────────────────────



async function getChatHistory(req, res, next) {

  try {

    const history = await aiService.loadChatHistory(req.user.id);

    return sendSuccess(res, history);

  } catch (err) {

    next(err);

  }

}



async function clearChatHistoryHandler(req, res, next) {

  try {

    await aiService.clearChatHistory(req.user.id);

    return sendSuccess(res, { cleared: true });

  } catch (err) {

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 2. STREAMING CHAT (kept synchronous — real-time UX requirement)

// ─────────────────────────────────────────────────────────────────────────────



async function chat(req, res, next) {

  try {

    const { message, history } = req.body;

    const userId = req.user.id;



    if (!message?.trim()) {

      return res.status(400).json({ success: false, message: 'message is required.' });

    }



    const [txResult, budgetResult] = await Promise.allSettled([

      transactionService.list(userId, {}),

      budgetService.list(userId),

    ]);



    const transactions = txResult.status === 'fulfilled'

      ? extractTransactions(txResult.value).slice(0, 26)

      : [];



    const budgets = budgetResult.status === 'fulfilled'

      ? (budgetResult.value?.data ?? budgetResult.value ?? [])

      : [];



    const financialContext = buildChatContext(transactions, budgets);

    const chatHistory = Array.isArray(history) ? history : await aiService.loadChatHistory(userId);



    // ── NEW: Intercept the native Express res.json method before sending to the service ──

    const originalJson = res.json.bind(res);



    // Inside your ai.controller.js -> chat() function -> res.json interceptor:



    res.json = async (data) => {

      if (data && data.triggerCategorizedSummary) {

        try {

          const requestedMonths = Array.isArray(data.months) ? data.months : [];

          if (!requestedMonths.length) {
            res.setHeader('Content-Type', 'application/json');
            return res.status(400).json({ success: false, message: 'No months were provided for the summary request.' });
          }

          const cachedSummary = await aiCache.getCategorizedSummary(userId, requestedMonths);

          if (cachedSummary) {
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).json({
              success: true,
              triggerCategorizedSummary: true,
              months: requestedMonths,
              summary: cachedSummary,
            });
          }

          const monthQueryResults = await Promise.allSettled(
            requestedMonths.map((monthReq) => {
              const year = Number(monthReq?.year);
              const month = Number(monthReq?.month);
              const startDate = new Date(Date.UTC(year, month - 1, 1));
              const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

              return transactionService.list(userId, {
                startDate,
                endDate,
                limit: 1000,
              });
            }),
          );

          const allTransactions = monthQueryResults.flatMap((result) => {
            if (result.status !== 'fulfilled') return [];
            return extractTransactions(result.value);
          });

          const summary = aiService.buildCategorizedSummary(allTransactions, requestedMonths);

          await aiCache.setCategorizedSummary(userId, requestedMonths, summary);

          res.setHeader('Content-Type', 'application/json');
          return res.status(200).json({
            success: true,
            triggerCategorizedSummary: true,
            months: requestedMonths,
            summary,
          });

        } catch (summaryError) {
          logger.error({ err: summaryError.message, userId }, '[AIController] Categorized summary generation failed.');
          res.setHeader('Content-Type', 'application/json');
          return res.status(500).json({ success: false, message: 'Unable to build the requested summary.' });
        }
      }

      if (data && data.triggerCalendarAction) {

        try {

          const queryResult = await query(

            `SELECT google_access_token, google_refresh_token 

         FROM oauth_accounts 

         WHERE user_id = $1 AND provider = 'google'`,

            [userId]

          );



          const rows = queryResult?.rows ?? [];

          const dbUser = rows[0];



          if (!dbUser || !dbUser.google_access_token) {

            // Fallback text output instead of structural JSON

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            return res.end('Please link your Google account to WealthFlux first to allow calendar scheduling.');

          }



          const backendBase = process.env.BACKEND_URL || `http://localhost:${config.PORT}`;

          const oauth2Client = new google.auth.OAuth2(

            config.GOOGLE_CLIENT_ID,

            config.GOOGLE_CLIENT_SECRET,

            `${backendBase}/api/auth/google/callback`

          );



          oauth2Client.setCredentials({

            access_token: dbUser.google_access_token,

            refresh_token: dbUser.google_refresh_token

          });



          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

          const { summary, startDateTime, endDateTime } = data.eventDetails;



          await calendar.events.insert({

            calendarId: 'primary',

            resource: {

              summary,

              description: 'Generated automatically by WealthFlux AI Financial Assistant.',

              start: { dateTime: startDateTime, timeZone: 'UTC' },

              end: { dateTime: endDateTime, timeZone: 'UTC' }

            }

          });



          const confirmationText = `📅 **Event Scheduled!** I've successfully added "${summary}" to your Google Calendar for ${new Date(startDateTime).toLocaleString()}.`;



          // 1. Record assistant's confirmation back into the database

          await aiService.saveChatMessage(userId, 'assistant', confirmationText);



          // ── FIXED: Stream the text response directly down the open socket wire ──

          // This tricks the frontend layout into reading it as a natural text reply.

          res.setHeader('Content-Type', 'text/plain; charset=utf-8');

          res.write(confirmationText);

          return res.end();



        } catch (calendarError) {

          logger.error({ err: calendarError.message, userId }, '[AIController] Google Calendar insertion failed.');



          res.setHeader('Content-Type', 'text/plain; charset=utf-8');

          return res.end("I parsed your scheduling request, but encountered a system synchronization issue updating your Google Calendar.");

        }

      }



      return originalJson(data);

    };



    // Forward variables down into the runtime streaming service layer pipeline

    await aiService.chatService({

      userId,

      message,

      history: chatHistory,

      financialContext,

      res,

      next,

    });

  } catch (err) {

    next(err);

  }

}





// ─────────────────────────────────────────────────────────────────────────────

// 3. ASYNC ANALYZE (enqueue → return jobId)

// ─────────────────────────────────────────────────────────────────────────────



async function analyze(req, res, next) {

  try {

    const userId = req.user.id;

    const { startDate, endDate, promptContext } = req.body ?? {};



    logger.info({ userId, startDate, endDate }, '[AIController] Analyze requested.');



    const { jobId } = await aiQueue.enqueueAnalyze(userId, { startDate, endDate, promptContext });



    return res.status(202).json({

      success: true,

      data: {

        jobId,

        message: 'Analysis queued. Poll GET /api/ai/jobs/:jobId for results.',

        estimatedSeconds: 15,

      },

    });

  } catch (err) {

    logger.error({ err: err.message }, '[AIController] Analyze enqueue failed.');

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 4. ASYNC SUGGEST (enqueue → return jobId)

// ─────────────────────────────────────────────────────────────────────────────



async function suggest(req, res, next) {

  try {

    const userId = req.user.id;

    const { promptContext } = req.body ?? {};



    logger.info({ userId }, '[AIController] Suggest requested.');



    const { jobId } = await aiQueue.enqueueSuggest(userId, { promptContext });



    return res.status(202).json({

      success: true,

      data: {

        jobId,

        message: 'Suggestions queued. Poll GET /api/ai/jobs/:jobId for results.',

        estimatedSeconds: 15,

      },

    });

  } catch (err) {

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 5. ASYNC INSIGHTS (per month — enqueue → return jobId)

// ─────────────────────────────────────────────────────────────────────────────



async function requestInsights(req, res, next) {

  try {

    const userId = req.user.id;

    const month = parseInt(req.params.month, 10);

    const year = parseInt(req.params.year, 10);



    if (!month || !year || month < 1 || month > 12) {

      return res.status(400).json({ success: false, message: 'Valid month (1-12) and year are required.' });

    }



    const { jobId } = await aiQueue.enqueueInsights(userId, month, year);



    return res.status(202).json({

      success: true,

      data: {

        jobId,

        message: `Insights for ${year}-${month} queued. Poll GET /api/ai/jobs/:jobId for results.`,

      },

    });

  } catch (err) {

    next(err);

  }

}



/**

 * GET /api/ai/insights — returns persisted insights from ai_insights table.

 */

async function getInsightsHistory(req, res, next) {

  try {

    const userId = req.user.id;

    const { month, year, limit = 10 } = req.query;



    let sql = 'SELECT * FROM ai_insights WHERE user_id = $1';

    const vals = [userId];

    let idx = 2;



    if (month) { sql += ` AND target_month = $${idx++}`; vals.push(Number(month)); }

    if (year) { sql += ` AND target_year  = $${idx++}`; vals.push(Number(year)); }



    sql += ` ORDER BY created_at DESC LIMIT $${idx}`;

    vals.push(Number(limit));



    const result = await query(sql, vals);

    return sendSuccess(res, result.rows ?? result);

  } catch (err) {

    next(err);

  }

}



/**

 * PATCH /api/ai/insights/:id/apply — marks an insight as applied.

 */

async function markInsightApplied(req, res, next) {

  try {

    const { id } = req.params;

    const userId = req.user.id;

    const { isApplied = true } = req.body;



    const result = await query(

      `UPDATE ai_insights

       SET is_applied = $1, updated_at = NOW()

       WHERE id = $2 AND user_id = $3

       RETURNING *`,

      [isApplied, id, userId],

    );



    const row = result.rows?.[0] ?? result[0];

    if (!row) throw new AppError('Insight not found.', 404);



    return sendSuccess(res, row);

  } catch (err) {

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 6. JOB STATUS POLLING

// ─────────────────────────────────────────────────────────────────────────────



async function getJobStatus(req, res, next) {

  try {

    const { jobId } = req.params;

    const status = await aiQueue.getJobStatus(jobId);

    return sendSuccess(res, status);

  } catch (err) {

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 7. RECEIPT SCANNER (synchronous — small file, fast)

// ─────────────────────────────────────────────────────────────────────────────



async function scanReceipt(req, res, next) {

  try {

    if (!req.file) {

      return res.status(400).json({ success: false, message: 'No image file uploaded.' });

    }

    const result = await aiService.receiptService(req.file.path);

    return sendSuccess(res, result);

  } catch (err) {

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 8. FINANCIAL LITERACY EDUCATION

// ─────────────────────────────────────────────────────────────────────────────



async function getEducationTopics(req, res, next) {

  try {

    const result = await aiService.educationService('all');

    return sendSuccess(res, result);

  } catch (err) { next(err); }

}



async function getEducationTip(req, res, next) {

  try {

    const index = parseInt(req.params.index ?? '0', 10);

    const result = await aiService.educationService(index);

    return sendSuccess(res, result);

  } catch (err) { next(err); }

}



async function getEducationTipByTopic(req, res, next) {

  try {

    const topic = decodeURIComponent(req.params.name ?? '');

    const result = await aiService.educationService(topic);

    return sendSuccess(res, result);

  } catch (err) { next(err); }

}



// ─────────────────────────────────────────────────────────────────────────────

// 9. MONTHLY PDF REPORT (async-queued)

// ─────────────────────────────────────────────────────────────────────────────



async function getMonthlyReport(req, res, next) {

  try {

    const userId = req.user.id;

    const month = req.params.month; // 'YYYY-MM'



    if (!/^\d{4}-\d{2}$/.test(month)) {

      return res.status(400).json({ success: false, message: 'month must be YYYY-MM format.' });

    }



    const { jobId } = await aiQueue.enqueueReport(userId, month);



    return res.status(202).json({

      success: true,

      data: {

        jobId,

        message: `Report for ${month} queued. Poll GET /api/ai/jobs/:jobId for status.`,

        estimatedSeconds: 30,

      },

    });

  } catch (err) {

    next(err);

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 10. CIRCUIT BREAKER STATUS (ops / health check)

// ─────────────────────────────────────────────────────────────────────────────



function getCircuitStatus(req, res) {

  return sendSuccess(res, gateway.getCircuitStatus());

}



// ─────────────────────────────────────────────────────────────────────────────

module.exports = {

  getChatHistory,

  clearChatHistory: clearChatHistoryHandler,

  chat,

  analyze,

  suggest,

  requestInsights,

  getInsightsHistory,

  markInsightApplied,

  getJobStatus,

  scanReceipt,

  getEducationTopics,

  getEducationTip,

  getEducationTipByTopic,

  getMonthlyReport,

  getCircuitStatus,

};