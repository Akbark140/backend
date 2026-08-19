// src/modules/ai/ai.engine.js

const axios = require('axios');

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL      = 'llama3.2:1b';

/**
 * STREAMING — pipes Ollama chunks directly to an Express response.
 * Used by: chatService (real-time chat UI)
 */
async function streamToClient(prompt, options = {}, res, next) {
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const response = await axios.post(
      OLLAMA_URL,
      {
        model:      MODEL,
        prompt,
        stream:     true,
        keep_alive: -1,
        options: {
          temperature: options.temperature ?? 0.4,
          num_predict: options.num_predict ?? 512,
          top_p:       0.9,
        },
      },
      { responseType: 'stream', timeout: 30000 }
    );

    let buffer = '';

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.response) res.write(json.response);
        } catch (_) {
          // Incomplete JSON packet — held in buffer, safe to ignore here
        }
      }
    });

    response.data.on('end',   () => res.end());
    response.data.on('error', (err) => {
      console.error('Stream error:', err);
      res.end();
    });

  } catch (err) {
    console.error('AI Engine streamToClient error:', err.message);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.write('AI is temporarily unavailable. Please try again in a moment.');
    res.end();
  }
}

/**
 * NON-STREAMING — waits for full Ollama response, returns a string.
 * Used by: ai.receipt.js, ai.report.js, ai.education.js, ai.insights.js
 */
async function generateOnce(prompt, options = {}) {
  const response = await axios.post(
    OLLAMA_URL,
    {
      model:   MODEL,
      prompt,
      stream:  false,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.num_predict ?? 512,
      },
    },
    { timeout: 60000 }
  );

  return response.data.response?.trim() ?? '';
}

/**
 * Strips markdown code fences and parses JSON safely.
 * Shared helper used across service files.
 */
function parseJson(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { streamToClient, generateOnce, parseJson };