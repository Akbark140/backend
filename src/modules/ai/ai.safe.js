// ai.safe.js
const logger = require('../../config/logger.config').logger;

async function safeAI(fn, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isOverload =
        err?.code === 503 ||
        err?.status === 'UNAVAILABLE' ||
        String(err?.message || '').includes('UNAVAILABLE');

      if (!isOverload) throw err;

      const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
      logger.warn(`Gemini overloaded. Retry ${i + 1}/${retries} in ${delay}ms`);

      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}

module.exports = safeAI;