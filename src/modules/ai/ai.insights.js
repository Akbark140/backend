// src/modules/ai/ai.insights.js

const axios = require('axios');

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'llama3.2:1b';

async function generateInsightsSummary({ user, thisWeek, lastWeek }) {
  // ── Calculate category totals ─────────────────────────
  function groupByCategory(transactions) {
    return transactions.reduce((acc, t) => {
      const cat = t.categoryName || 'Uncategorized';
      acc[cat] = (acc[cat] || 0) + Number(t.amount);
      return acc;
    }, {});
  }

  const thisWeekTotals  = groupByCategory(thisWeek);
  const lastWeekTotals  = groupByCategory(lastWeek);

  const thisWeekTotal   = thisWeek.reduce((a, t) => a + Number(t.amount), 0).toFixed(2);
  const lastWeekTotal   = lastWeek.reduce((a, t) => a + Number(t.amount), 0).toFixed(2);
  const diff            = (thisWeekTotal - lastWeekTotal).toFixed(2);
  const direction       = diff > 0 ? 'more' : 'less';

  // ── Build prompt ──────────────────────────────────────
  const prompt = `
You are WealthFlux AI, a personal financial assistant writing a weekly spending summary email.

User: ${user.name}
Currency: ${user.currency || 'USD'}

This week's spending: ${user.currency || '$'}${thisWeekTotal}
Last week's spending: ${user.currency || '$'}${lastWeekTotal}
Difference: ${user.currency || '$'}${Math.abs(diff)} ${direction} than last week

This week by category:
${Object.entries(thisWeekTotals).map(([cat, amt]) => `- ${cat}: ${user.currency || '$'}${amt.toFixed(2)}`).join('\n')}

Last week by category:
${Object.entries(lastWeekTotals).map(([cat, amt]) => `- ${cat}: ${user.currency || '$'}${amt.toFixed(2)}`).join('\n')}

Write a friendly, concise weekly spending summary for ${user.name}. Include:
1. Overall spending comparison (this week vs last week)
2. Which categories increased or decreased
3. One specific saving tip based on their biggest expense
4. One motivational sentence to end

Keep it under 200 words. Do not use bullet points — write in natural paragraphs.
AI:
`;

  // ── Call Ollama (non-streaming for email) ─────────────
  const response = await axios.post(OLLAMA_URL, {
    model: MODEL,
    prompt,
    stream: false,
    options: { temperature: 0.5, num_predict: 400 },
  });

  return {
    summary:       response.data.response,
    thisWeekTotal,
    lastWeekTotal,
    diff:          Math.abs(diff),
    direction,
    thisWeekTotals,
    lastWeekTotals,
  };
}

module.exports = { generateInsightsSummary };