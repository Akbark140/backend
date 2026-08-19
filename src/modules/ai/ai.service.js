'use strict';



/**

 * @module ai/ai.service

 * @description Production AI service — coordinates gateway, cache, DB persistence,

 * and all Gemini model calls for WealthFlux.

 *

 * Architecture

 * ─────────────

 *  Streaming chat  → gateway.stream()  (real-time SSE to client)

 *  All other calls → gateway.call()    (resilient, retried, circuit-broken)

 *  Results cached  → ai.cache          (Redis, domain-specific TTLs)

 *  Insights stored → ai_insights table (permanent record, queryable)

 *

 * Nothing here touches HTTP objects (req/res) except chatService, which must

 * stream directly to the response.

 */



require('dotenv').config();



const { Type }   = require('@google/genai');

const { query }  = require('../../config/db.config');

const { logger } = require('../../config/logger.config');

const gateway    = require('./ai.gateway');

const aiCache    = require('./ai.cache');



// ─────────────────────────────────────────────────────────────────────────────

// INTERNAL HELPERS

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Persists an AI insight to the ai_insights table.

 *

 * Schema columns used:

 *   id, user_id, type, target_month, target_year,

 *   insight_text, recommended_budget, confidence_score,

 *   is_applied, created_at, updated_at

 */

async function persistInsight(userId, { type, targetMonth, targetYear, insightText, recommendedBudget, confidenceScore }) {

  try {

    await query(

      `INSERT INTO ai_insights

         (user_id, type, target_month, target_year, insight_text,

          recommended_budget, confidence_score, is_applied)

       VALUES ($1, $2, $3, $4, $5, $6, $7, false)

       ON CONFLICT DO NOTHING`,

      [

        userId,

        type          ?? 'general',

        targetMonth   ?? null,

        targetYear    ?? null,

        insightText,

        recommendedBudget ? JSON.stringify(recommendedBudget) : null,

        confidenceScore   ?? null,

      ],

    );

  } catch (err) {

    // Non-fatal — log and continue; insight is still returned to caller

    logger.warn({ err: err.message, userId }, '[AIService] Failed to persist insight to DB.');

  }

}



/**

 * Saves a chat message to the chat_history table.

 * Matches schema: id(uuid), user_id(uuid), role, context, created_at

 */

async function saveChatMessage(userId, role, content) {

  if (!content?.trim()) return;

  try {

    // Root cause: chat text was being JSON-stringified before insert, which caused
    // history reloads to return escaped content and broke conversation memory.
    const normalizedContent = String(content).trim();



    await query(

      `INSERT INTO chat_history (user_id, role, content, created_at)
       VALUES ($1, $2, $3, NOW())`,

      [userId, role, normalizedContent],

    );

  } catch (err) {

    logger.warn({ err: err.message, userId, role }, '[AIService] Failed to save chat message.');

  }

}


function normalizeHistoryContent(msg) {
  return msg?.content ?? msg?.context ?? msg?.text ?? '';
}

function normalizeAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCategory(transaction, fallbackType = 'expense') {
  if (!transaction || typeof transaction !== 'object') {
    return fallbackType === 'income' ? 'Income' : 'Uncategorized';
  }

  const categoryName = transaction.categoryName ?? transaction.category_name ?? transaction.category;
  if (categoryName) return String(categoryName);
  return fallbackType === 'income' ? 'Income' : 'Uncategorized';
}

function formatMonthLabel(year, month) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function detectPossibleDuplicates(transactions = []) {
  const grouped = new Map();

  for (const transaction of transactions) {
    const description = String(transaction?.description ?? '').trim();
    const amount = normalizeAmount(transaction?.amount ?? transaction?.amount_in_base_currency ?? transaction?.amountInBaseCurrency);
    const dateValue = transaction?.date ?? transaction?.createdAt ?? transaction?.created_at;
    const parsedDate = dateValue ? new Date(dateValue) : null;

    if (!description || !amount || !parsedDate || Number.isNaN(parsedDate.getTime())) {
      continue;
    }

    const key = `${description.toLowerCase()}::${amount}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push({ description, amount, date: parsedDate });
    grouped.set(key, bucket);
  }

  return Array.from(grouped.values())
    .filter(group => group.length > 1)
    .map(group => {
      const sorted = [...group].sort((a, b) => a.date - b.date);
      const first = sorted[0];
      const second = sorted[1];
      const deltaMs = second.date - first.date;
      const sameDay = deltaMs <= 24 * 60 * 60 * 1000;
      if (!sameDay) return null;
      return {
        description: first.description,
        amount: first.amount,
        dates: sorted.map(item => item.date.toISOString()),
      };
    })
    .filter(Boolean);
}

function buildCategorizedSummary(transactions = [], requestedMonths = []) {
  const normalizedTransactions = Array.isArray(transactions) ? transactions.filter(Boolean) : [];
  const months = (Array.isArray(requestedMonths) ? requestedMonths : []).map((monthReq) => {
    const year = Number(monthReq?.year);
    const month = Number(monthReq?.month);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const monthTransactions = normalizedTransactions
      .filter((transaction) => {
        const dateValue = transaction?.date ?? transaction?.createdAt ?? transaction?.created_at;
        const parsedDate = dateValue ? new Date(dateValue) : null;
        if (!parsedDate || Number.isNaN(parsedDate.getTime())) return false;
        return parsedDate >= start && parsedDate <= end;
      })
      .sort((left, right) => {
        const leftDate = new Date(left?.date ?? left?.createdAt ?? left?.created_at ?? 0);
        const rightDate = new Date(right?.date ?? right?.createdAt ?? right?.created_at ?? 0);
        return rightDate - leftDate;
      });

    const totals = { income: 0, expense: 0, net: 0 };
    const categoriesByType = {
      income: new Map(),
      expense: new Map(),
    };

    monthTransactions.forEach((transaction) => {
      const type = transaction?.type === 'income' ? 'income' : 'expense';
      const amount = normalizeAmount(transaction?.amount ?? transaction?.amount_in_base_currency ?? transaction?.amountInBaseCurrency ?? transaction?.amountInBaseCurrency);
      if (type === 'income') totals.income += amount;
      if (type === 'expense') totals.expense += amount;

      const bucket = categoriesByType[type];
      const category = normalizeCategory(transaction, type);
      bucket.set(category, (bucket.get(category) ?? 0) + amount);
    });

    totals.net = totals.income - totals.expense;

    return {
      year,
      month,
      label: formatMonthLabel(year, month),
      totals,
      categories: [
        ...Array.from(categoriesByType.income.entries()).map(([name, total]) => ({ name, total, type: 'income' })),
        ...Array.from(categoriesByType.expense.entries()).map(([name, total]) => ({ name, total, type: 'expense' })),
      ],
      transactions: monthTransactions,
    };
  });

  const comparison = months.length > 1 ? (() => {
    const previousMonth = months[0];
    const currentMonth = months[months.length - 1];
    const categoryNames = new Set([
      ...previousMonth.categories.map(({ name }) => name),
      ...currentMonth.categories.map(({ name }) => name),
    ]);

    const categories = Array.from(categoryNames).map((name) => {
      const previous = previousMonth.categories.find((entry) => entry.name === name)?.total ?? 0;
      const current = currentMonth.categories.find((entry) => entry.name === name)?.total ?? 0;
      const delta = current - previous;
      let direction = 'stable';
      if (delta > 0) direction = 'increase';
      if (delta < 0) direction = 'decrease';

      const percentage = previous === 0 ? (current === 0 ? 0 : 100) : ((current - previous) / previous) * 100;
      return { name, previous, current, delta, percentage, direction };
    });

    return {
      categories,
      totalIncomeDelta: currentMonth.totals.income - previousMonth.totals.income,
      totalExpenseDelta: currentMonth.totals.expense - previousMonth.totals.expense,
      netDelta: currentMonth.totals.net - previousMonth.totals.net,
    };
  })() : null;

  return {
    months,
    comparison,
    possibleDuplicates: detectPossibleDuplicates(normalizedTransactions),
  };
}


function parseCalendarDateTime(input, { timezone = 'UTC' } = {}) {
  const raw = String(input ?? '').trim();

  if (!raw) {
    return { isoString: null, displayText: 'an unspecified time', timezone };
  }

  const isoCandidate = new Date(raw);
  if (!Number.isNaN(isoCandidate.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return {
      isoString: isoCandidate.toISOString(),
      displayText: new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        dateStyle: 'long',
        timeStyle: 'short',
      }).format(isoCandidate),
      timezone,
    };
  }

  const dateMatch = raw.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);

  if (!dateMatch) {
    const fallback = new Date(raw);
    if (!Number.isNaN(fallback.getTime())) {
      return {
        isoString: fallback.toISOString(),
        displayText: new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          dateStyle: 'long',
          timeStyle: 'short',
        }).format(fallback),
        timezone,
      };
    }

    return { isoString: null, displayText: raw, timezone };
  }

  const [, dayRaw, monthRaw, yearRaw] = dateMatch;
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = yearRaw ? Number(yearRaw) : new Date().getFullYear() + 1;

  const remainder = raw.slice(dateMatch.index + dateMatch[0].length);
  const timeMatch = remainder.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);

  let hour = 12;
  let minute = 0;

  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const meridiem = timeMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }

  const parsedDate = new Date(Date.UTC(year, month - 1, day, hour, minute));

  return {
    isoString: parsedDate.toISOString(),
    displayText: new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(parsedDate),
    timezone,
  };
}


const calendarToolDeclaration = {

  name: 'createCalendarEvent',

  description: 'Create a new event in the user\'s Google Calendar. Use this only for explicit scheduling requests such as booking a meeting, appointment, or reminder.',

  parameters: {

    type: Type.OBJECT,

    properties: {

      summary: {

        type: Type.STRING,

        description: 'The title or topic of the event (e.g., "Dentist Appointment", "Weekly Budget Sync").',

      },

      startDateTime: {

        type: Type.STRING,

        description: 'The start date and time in ISO 8601 format (e.g., "2026-06-22T15:00:00Z").',

      },

      endDateTime: {

        type: Type.STRING,

        description: 'The end date and time in ISO 8601 format. If omitted, default to 1 hour after startDateTime.',

      },

    },

    required: ['summary', 'startDateTime'],

  },

};

const categorizedSummaryToolDeclaration = {
  name: 'getCategorizedSummary',
  description: 'Fetch the user\'s transactions for one or more specific months, grouped by category and income/expense type. Use this for month-specific spending, income, or transaction breakdown requests, including comparisons between months and requests like "last month".',
  parameters: {
    type: Type.OBJECT,
    properties: {
      months: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            year: { type: Type.NUMBER },
            month: { type: Type.NUMBER, description: '1-12' },
          },
          required: ['year', 'month'],
        },
        description: 'One entry per requested month, resolved against the current date anchor already provided in the system prompt.',
      },
    },
    required: ['months'],
  },
};



// ─────────────────────────────────────────────────────────────────────────────

// 1. AUTOMATIC TRANSACTION CATEGORISATION

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Categorises a single raw transaction description.

 * Checks Redis cache first (7-day TTL) before calling the model.

 *

 * @param {string}   rawInput            - Raw merchant/description string.

 * @param {object[]} availableCategories - [{ id, name }]

 * @returns {Promise<{ categoryId: string|null, cleanDescription: string }>}

 */





async function automaticallyCategorize(rawInput, availableCategories) {

  const merchantNorm = rawInput.toLowerCase().trim().slice(0, 120);



  // Cache check

  const cached = await aiCache.getCategorization(merchantNorm);

  if (cached) {

    logger.debug({ merchantNorm }, '[AIService] Categorization cache HIT.');

    return { categoryId: cached, cleanDescription: rawInput };

  }



  const categoryMapString = availableCategories

    .map(c => `ID: "${c.id}" -> Name: "${c.name}"`)

    .join('\n');



  const systemPrompt = `You are an automated fintech parsing engine for WealthFlux.



Allowed Categories:

${categoryMapString}



Rules:

1. categoryId MUST match one of the IDs exactly above.

2. cleanDescription must remove prices and currency symbols.

3. Return ONLY valid JSON — no markdown or explanation.`;



  try {

    const response = await gateway.call(

      (model, ai) => ai.models.generateContent({

        model,

        contents: `Raw Input: "${rawInput}"`,

        config: {

          systemInstruction: systemPrompt,

          temperature: 0.1,

          responseMimeType: 'application/json',

          responseSchema: {

            type: Type.OBJECT,

            properties: {

              categoryId:       { type: Type.STRING },

              cleanDescription: { type: Type.STRING },

            },

            required: ['categoryId', 'cleanDescription'],

          },

        },

      }),

      { label: 'categorize', timeoutMs: 15_000 },

    );



    const parsed = JSON.parse(response.text.trim());



    // Store in cache for future duplicate merchants

    if (parsed.categoryId) {

      await aiCache.setCategorization(merchantNorm, parsed.categoryId);

    }



    return parsed;

  } catch (error) {

    logger.error({ err: error.message }, '[AIService] Categorization failed — returning fallback.');

    return {

      categoryId:       availableCategories[0]?.id ?? null,

      cleanDescription: rawInput,

    };

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 2. STREAMING AI CHAT

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Streams an AI chat response directly to the HTTP response object.

 * Saves user message + AI reply to chat_history.

 *

 * @param {object} params

 * @param {string} params.userId

 * @param {string} params.message

 * @param {object[]} params.history       - Previous messages [{ role, content }]

 * @param {string} params.financialContext - Pre-built financial summary string

 * @param {object} params.res             - Express response object

 * @param {Function} params.next          - Express next()

 */



async function chatService({ userId, message, history = [], financialContext = '', res, next }) {

  // Persist user message before streaming begins

  await saveChatMessage(userId, 'user', message);



  const currentDateTime = new Date().toISOString();



  const systemPrompt = `You are WealthFlux AI, a personal finance assistant.



Rules:

- Only use the provided financial data. Never invent numbers.

- Be concise and practical. Use bullet points when helpful.

- If the user asks something outside personal finance, politely redirect.

- I can create calendar events, but I cannot currently edit or delete existing calendar events.

- For calendar scheduling requests, I should first confirm the parsed date and time before creating anything.

- If the user asks for a table, comparison, or monthly breakdown, respond using GitHub-flavored markdown tables. Use bullet points only for simple unstructured lists.

- Use the getCategorizedSummary tool whenever the user asks about spending, income, transactions, or comparisons for a specific month, month range, "last month", or similar month-scoped request.

- Current Date and Time reference anchor: ${currentDateTime}. Use this for resolving relative timing phrases like 'tomorrow' or 'next week'.



Financial Context:

${financialContext}`;



  const formattedContents = [

    { role: 'user', parts: [{ text: `System Context:\n${systemPrompt}` }] },

  ];



  if (Array.isArray(history)) {

    history.slice(-20).forEach(msg => {

      formattedContents.push({

        role:  msg.role === 'user' ? 'user' : 'model',

        parts: [{ text: normalizeHistoryContent(msg) }],

      });

    });

  }



  formattedContents.push({ role: 'user', parts: [{ text: message }] });



  try {

    const aiStream = await gateway.stream(

      (model, ai) => ai.models.generateContentStream({

        model,

        contents: formattedContents,

        config: { 

          temperature: 0.3, 

          topP: 0.9, 

          maxOutputTokens: 1024,

          tools: [{ functionDeclarations: [calendarToolDeclaration, categorizedSummaryToolDeclaration] }]

        },

      }),

      { label: 'chat-stream', timeoutMs: 60_000 },

    );



    // ── STEP 1: Intercept headers by preparing custom chunk monitoring ──

    let isToolCall = false;

    let toolArgs = null;
    let toolName = null;



    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    res.setHeader('Transfer-Encoding', 'chunked');

    res.setHeader('Cache-Control', 'no-cache');



    let aiReply = '';

    const { StringDecoder } = require('string_decoder');

    const decoder       = new StringDecoder('utf-8');

    const originalWrite = res.write.bind(res);

    const originalEnd   = res.end.bind(res);



    res.write = (chunk, encoding, callback) => {

      aiReply += typeof chunk === 'string' ? chunk : decoder.write(chunk);

      return originalWrite(chunk, encoding, callback);

    };



    res.end = async (...args) => {

      try {

        aiReply += decoder.end();

        // Only save to DB if it was text (don't save the raw structural JSON payload)

        if (!isToolCall) {

          await saveChatMessage(userId, 'assistant', aiReply);

        }

      } catch (err) {

        logger.warn({ err: err.message }, '[AIService] Failed to persist assistant reply.');

      }

      return originalEnd(...args);

    };



    // ── STEP 2: Buffer streamed text until the tool-call decision is clear ──

    let bufferedText = '';

    for await (const chunk of aiStream) {

      if (chunk.functionCalls && chunk.functionCalls.length > 0) {

        isToolCall = true;
        toolName = chunk.functionCalls[0].name;
        toolArgs = chunk.functionCalls[0].args;
        break;

      }

      if (chunk.text) {
        bufferedText += chunk.text;
      }

    }

    if (isToolCall && toolArgs) {

      if (toolName === 'getCategorizedSummary') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({
          success: true,
          triggerCategorizedSummary: true,
          months: toolArgs.months ?? [],
        });
      }

      res.setHeader('Content-Type', 'application/json');

      return res.status(200).json({

        success: true,

        triggerCalendarAction: true,

        eventDetails: {

          summary: toolArgs.summary,

          startDateTime: toolArgs.startDateTime,

          endDateTime: toolArgs.endDateTime || new Date(new Date(toolArgs.startDateTime).getTime() + 60 * 60 * 1000).toISOString()

        }

      });

    }

    aiReply = bufferedText;

    await saveChatMessage(userId, 'assistant', aiReply);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write(aiReply);
    res.end();

  } catch (err) {

    logger.error({ err: err.message }, '[AIService] Chat streaming failed.');

    if (!res.headersSent) return next(err);

    res.end();

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// 3. MONTHLY SPENDING INSIGHTS (async-safe, cacheable, DB-persisted)

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Generates monthly spending insights for a user.

 * Checks cache first; stores result in Redis + ai_insights table.

 *

 * @param {string} userId

 * @param {number} month  - 1-12

 * @param {number} year

 * @param {object} financialContext - { summary, topCategories, sampleTransactions }

 * @returns {Promise<{ insightText: string, recommendations: object[] }>}

 */

async function generateInsights(userId, month, year, financialContext) {

  // Cache check

  const cached = await aiCache.getInsights(userId, year, month);

  if (cached) {

    logger.info({ userId, month, year }, '[AIService] Insights cache HIT.');

    return cached;

  }



  const { summary, topCategories = {}, sampleTransactions = [] } = financialContext ?? {};



  if (!summary) throw new Error('[AIService] Missing financial summary for insights generation.');



  const prompt = `You are a financial analyst reviewing a user's monthly finances.



Period: ${year}-${String(month).padStart(2, '0')}

Income:   ${summary.totalIncome}

Expenses: ${summary.totalExpenses}

Savings:  ${summary.netSavings}



Spending by category:

${JSON.stringify(topCategories, null, 2)}



Sample transactions:

${JSON.stringify(sampleTransactions.slice(0, 10), null, 2)}



Generate:

1. Key insight paragraph (2-3 sentences) summarising this month's financial health.

2. Top 3 actionable recommendations as a JSON array: [{ title, description, priority }]

3. A budget health score from 0-100 (100 = perfect).



Respond ONLY with valid JSON:

{

  "insightText": "...",

  "recommendations": [...],

  "budgetHealthScore": 0-100,

  "confidenceScore": 0.0-1.0

}`;



  const response = await gateway.call(

    (model, ai) => ai.models.generateContent({

      model,

      contents: prompt,

      config: {

        temperature:        0.2,

        responseMimeType:  'application/json',

        maxOutputTokens:   1500,

      },

    }),

    { label: 'insights', timeoutMs: 30_000 },

  );



  let result;

  try {

    const clean = response.text.replace(/```json|```/g, '').trim();

    result = JSON.parse(clean);

  } catch {

    result = { insightText: response.text, recommendations: [], budgetHealthScore: 50, confidenceScore: 0.5 };

  }



  // Persist to cache and DB concurrently

  await Promise.allSettled([

    aiCache.setInsights(userId, year, month, result),

    persistInsight(userId, {

      type:             'monthly_insights',

      targetMonth:      month,

      targetYear:       year,

      insightText:      result.insightText,

      recommendedBudget: result.recommendations,

      confidenceScore:  result.confidenceScore,

    }),

  ]);



  logger.info({ userId, month, year }, '[AIService] Insights generated and cached.');

  return result;

}



// ─────────────────────────────────────────────────────────────────────────────

// 4. ON-DEMAND ANALYSIS

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Generates an on-demand analysis for a date range.

 * Results are cached for 1 hour to avoid re-billing the same request.

 *

 * @param {string} userId

 * @param {object} financialContext - { summary, topCategories, sampleTransactions }

 * @param {string} [customPrompt]

 * @returns {Promise<string>}  Markdown analysis text

 */

async function analyzeService(userId, financialContext, customPrompt = '') {

  const { summary, topCategories, sampleTransactions } = financialContext ?? {};

  if (!summary) throw new Error('Missing financial summary');



  // Cache check keyed by userId + date range

  const cacheKey = await aiCache.getAnalysis(

    userId,

    summary.period?.startDate ?? 'all',

    summary.period?.endDate   ?? 'now',

  );

  if (cacheKey) {

    logger.info({ userId }, '[AIService] Analysis cache HIT.');

    return cacheKey;

  }



  const prompt = `You are a strict financial analyst AI.



Income:   ${summary.totalIncome}

Expenses: ${summary.totalExpenses}

Savings:  ${summary.netSavings}

Period:   ${summary.period?.startDate ?? 'N/A'} → ${summary.period?.endDate ?? 'now'}



Categories:

${JSON.stringify(topCategories, null, 2)}



Sample Transactions:

${JSON.stringify(sampleTransactions, null, 2)}



${customPrompt ? `Focus: ${customPrompt}` : ''}



Provide a concise financial analysis with actionable insights. Use markdown headings.`;



  const response = await gateway.call(

    (model, ai) => ai.models.generateContent({

      model,

      contents: prompt,

      config: { temperature: 0.2, maxOutputTokens: 2000 },

    }),

    { label: 'analyze', timeoutMs: 30_000 },

  );



  const text = response.text;



  await aiCache.setAnalysis(

    userId,

    summary.period?.startDate ?? 'all',

    summary.period?.endDate   ?? 'now',

    text,

  );



  return text;

}



// ─────────────────────────────────────────────────────────────────────────────

// 5. SAVINGS SUGGESTIONS

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Generates savings/optimisation suggestions.

 * Cached for 6 hours.

 *

 * @param {string} userId

 * @param {object} profile - { metrics, spendingPattern, highValueExpenses }

 * @param {string} [customPrompt]

 * @returns {Promise<string>}

 */

async function suggestService(userId, profile, customPrompt = '') {

  // Cache check

  const cached = await aiCache.getSuggestions(userId);

  if (cached) {

    logger.info({ userId }, '[AIService] Suggestions cache HIT.');

    return cached;

  }



  const { metrics = {}, spendingPattern = {}, highValueExpenses = [] } = profile ?? {};



  const prompt = `You are a financial optimisation coach.



Income:        ${metrics.totalIncome}

Expenses:      ${metrics.totalExpenses}

Savings Rate:  ${metrics.savingsRatePercentage}%



Spending pattern:

${JSON.stringify(spendingPattern, null, 2)}



Top expenses:

${JSON.stringify(highValueExpenses, null, 2)}



${customPrompt || ''}



Give 5 practical, specific savings suggestions ranked by impact. Use markdown.`;



  const response = await gateway.call(

    (model, ai) => ai.models.generateContent({

      model,

      contents: prompt,

      config: { temperature: 0.3, maxOutputTokens: 1500 },

    }),

    { label: 'suggest', timeoutMs: 25_000 },

  );



  const text = response.text;

  await aiCache.setSuggestions(userId, text);

  return text;

}



// ─────────────────────────────────────────────────────────────────────────────

// 6. WRAPPERS (receipt, education, report — delegate to sub-modules)

// ─────────────────────────────────────────────────────────────────────────────



async function receiptService(filePath) {

  const { scanReceipt } = require('./ai.receipt');

  return scanReceipt(filePath);

}



async function educationService(topicOrIndex) {

  const { generateTip, generateTipByIndex, getAllTopics } = require('./ai.education');

  if (topicOrIndex === 'all') return { topics: getAllTopics() };

  if (typeof topicOrIndex === 'number') return generateTipByIndex(topicOrIndex);

  return generateTip(String(topicOrIndex));

}



async function reportService(reportData) {

  const { generateReport } = require('./ai.report');

  return generateReport(reportData);

}



// ─────────────────────────────────────────────────────────────────────────────

// 7. CHAT HISTORY DB HELPERS (exposed for controller use)

// ─────────────────────────────────────────────────────────────────────────────



async function loadChatHistory(userId, limit = 50) {

  const result = await query(

    `SELECT id, role, content, created_at

     FROM   chat_history

     WHERE  user_id = $1

     ORDER  BY created_at ASC

     LIMIT  $2`,

    [userId, limit],

  );

  const rows = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);

  return rows.map(msg => ({
    ...msg,
    content: msg.content ?? msg.context ?? '',
  }));

}



async function clearChatHistory(userId) {

  await query('DELETE FROM chat_history WHERE user_id = $1', [userId]);

}



// ─────────────────────────────────────────────────────────────────────────────

// EXPORTS

// ─────────────────────────────────────────────────────────────────────────────



module.exports = {

  automaticallyCategorize,

  chatService,

  generateInsights,

  analyzeService,

  suggestService,

  receiptService,

  educationService,

  reportService,

  loadChatHistory,

  clearChatHistory,

  saveChatMessage,

  persistInsight,

  parseCalendarDateTime,

  buildCategorizedSummary,

};