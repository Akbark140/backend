'use strict';

// src/modules/ai/ai.receipt.js
//
// Feature 11 — Receipt Scanner
// Pipeline: multer upload → Tesseract OCR → Gemini parse → structured fields
//
// What changed from the original
// ────────────────────────────────
// BEFORE: parseReceiptText called generateOnce() from ai.engine (Ollama, local)
//         Problem: Ollama had to be running locally; no retry on failure.
//
// NOW:    parseReceiptText calls gateway.call() (Gemini, with retry + circuit breaker)
//         Tesseract OCR pipeline is completely unchanged.
//         Fallback object on parse failure is unchanged.

const fs       = require('fs');
const Tesseract = require('tesseract.js');
const { Type } = require('@google/genai');
const gateway  = require('./ai.gateway');
const { logger } = require('../../config/logger.config');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: OCR  (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs Tesseract OCR on the uploaded image file.
 * @param {string} filePath
 * @returns {Promise<string>}  Raw extracted text.
 */
async function extractTextFromImage(filePath) {
  const { data: { text } } = await Tesseract.recognize(filePath, 'eng', {
    logger: () => {},   // suppress Tesseract progress logs
  });
  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: AI PARSE  (Gemini via gateway — was Ollama generateOnce)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends OCR text to Gemini via the gateway and extracts structured receipt data.
 *
 * Uses structured JSON output (responseMimeType + responseSchema) for reliability.
 * Gateway handles retry + circuit breaker — no extra try/catch needed here.
 *
 * @param {string} rawOcrText
 * @returns {Promise<{ merchant, total, date, currency, items[] }>}
 */
async function parseReceiptText(rawOcrText) {
  const prompt = `You are a receipt parsing engine for the WealthFlux finance app.
Extract structured data from the following OCR text of a receipt.

OCR Text:
"""
${rawOcrText}
"""

Rules:
- "total" must be a plain number, no currency symbols.
- "date" must be ISO format YYYY-MM-DD, or null if not found.
- "items" should list individual line items if visible; empty array if not.
- If merchant name is unclear, use "Unknown Merchant".
- "currency" should be the detected currency code or symbol (e.g. PKR, USD, Rs.).`;

  try {
    const response = await gateway.call(
      (model, ai) => ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature:       0.1,
          maxOutputTokens:   600,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              merchant: { type: Type.STRING },
              total:    { type: Type.NUMBER },
              date:     { type: Type.STRING },
              currency: { type: Type.STRING },
              items: {
                type:  Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name:   { type: Type.STRING },
                    amount: { type: Type.NUMBER },
                  },
                  required: ['name', 'amount'],
                },
              },
            },
            required: ['merchant', 'total', 'currency', 'items'],
          },
        },
      }),
      { label: 'receipt-parse', timeoutMs: 20_000 },
    );

    const parsed = JSON.parse(response.text.trim());

    // Normalise date: ensure it's either a valid YYYY-MM-DD string or null
    if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      parsed.date = null;
    }

    return parsed;
  } catch (err) {
    logger.warn({ err: err.message }, '[AIReceipt] Gemini parse failed — returning fallback.');
    return {
      merchant:   'Unknown Merchant',
      total:      0,
      date:       null,
      currency:   'PKR',
      items:      [],
      parseError: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT  (interface unchanged — called by ai.service.receiptService)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full receipt scan pipeline: OCR → AI parse → cleanup temp file.
 *
 * @param {string} filePath - Path to the uploaded image (from multer).
 * @returns {Promise<object>}
 */
async function scanReceipt(filePath) {
  try {
    const ocrText = await extractTextFromImage(filePath);

    if (!ocrText || ocrText.length < 10) {
      return {
        success: false,
        error:   'Could not extract readable text from this image. Please upload a clearer photo.',
        raw:     ocrText,
      };
    }

    const parsed = await parseReceiptText(ocrText);

    return {
      success: true,
      raw:     ocrText,
      ...parsed,
    };
  } finally {
    // Always clean up the temp file — same as original
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

module.exports = { scanReceipt };