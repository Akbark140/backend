// src/modules/ai/ai.education.js
//
// Feature 15 — Financial Education Section
// Returns AI-generated tips on personal finance topics.
//
const { generateOnce, parseJson } = require('./ai.engine');

/**
 * Full topic list rotated on the frontend.
 * Add or reorder freely — the AI handles all of them.
 */
const TOPICS = [
  'emergency fund',
  'how to save more money',
  'budgeting for students',
  'what is a savings rate',
  'reducing food expenses',
  'understanding monthly budgets',
  'how to get out of debt',
  'smart grocery shopping',
  'avoiding impulse purchases',
  'building a 6-month emergency fund',
  'difference between needs and wants',
  'how to set financial goals',
  'what is compound interest',
  'how to track your spending',
  'saving for a big purchase',
];

/**
 * generateTip(topic)
 * Asks Ollama for a structured financial tip on the given topic.
 * Returns { title, body, tip, topic }
 */
async function generateTip(topic) {
  const prompt = `
You are WealthFlux's financial education engine. Write a helpful, friendly tip about: "${topic}".

Respond with a raw JSON object ONLY — no markdown, no backticks:
{
  "title": "Short catchy title (under 8 words)",
  "body": "2-3 sentence explanation of the concept, simple and clear",
  "tip": "One specific actionable tip the user can apply today (1 sentence)"
}

Keep language simple. Target audience: everyday users aged 18-35 in Pakistan.
Amounts can reference PKR where relevant.
`;

  const raw = await generateOnce(prompt, { temperature: 0.5, num_predict: 300 });

  try {
    const parsed = parseJson(raw);
    return { topic, ...parsed };
  } catch {
    return {
      topic,
      title: `Understanding ${topic}`,
      body:  'Good financial habits start with awareness. Track where your money goes every month.',
      tip:   'Start by writing down your three biggest monthly expenses today.',
    };
  }
}

/**
 * generateTipsByIndex(index)
 * Rotates through TOPICS array by index so the frontend can
 * show a different tip each day without repeating.
 */
async function generateTipByIndex(index = 0) {
  const topic = TOPICS[index % TOPICS.length];
  return generateTip(topic);
}

/**
 * getAllTopics()
 * Returns the topics list so the frontend can build a carousel/index.
 */
function getAllTopics() {
  return TOPICS.map((t, i) => ({ index: i, topic: t }));
}

module.exports = { generateTip, generateTipByIndex, getAllTopics, TOPICS };