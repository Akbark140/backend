// src/modules/currency/currency.service.js

const repo = require('./currencies.repository');
const axios = require('axios'); // Still needed for the background sync function
const { logger } = require('../../config/logger.config');

/**
 * Fast database lookup for user transfers
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1.0;

  try {
    // Read directly from your local database cache
    const cached = await repo.getCachedRate(fromCurrency, toCurrency);
    
    if (!cached) {
      // Emergency Fallback: If a pair doesn't exist yet, try a one-off sync
      logger.warn(`[CURRENCY_SERVICE]: Missing rate for ${fromCurrency}_${toCurrency}. Running emergency sync.`);
      return await syncSpecificPair(fromCurrency, toCurrency);
    }

    return Number(cached.rate);
  } catch (error) {
    logger.error(`[CURRENCY_SERVICE_ERROR]: ${error.message}`);
    throw new Error('Currency conversion services are temporarily unavailable.');
  }
}

/**
 * Background worker function to fetch fresh rates from the external API
 * This will be called by our morning cron job
 */
async function syncSpecificPair(fromCurrency, toCurrency) {
  try {
    logger.info(`[CURRENCY_SYNC]: Fetching fresh API rates for ${fromCurrency}...`);
    const response = await axios.get(`https://open.er-api.com/v6/latest/${fromCurrency}`);
    const freshRate = response.data.rates[toCurrency];

    if (!freshRate) throw new Error(`Currency ${toCurrency} not supported by API.`);

    await repo.upsertRate(fromCurrency, toCurrency, freshRate);
    return Number(freshRate);
  } catch (error) {
    logger.error(`[CURRENCY_SYNC_FAILED]: Could not sync ${fromCurrency}_${toCurrency}: ${error.message}`);
    
    // If the sync fails but we have an old rate, use it as a safety buffer
    const fallback = await repo.getCachedRate(fromCurrency, toCurrency);
    if (fallback) return Number(fallback.rate);
    
    throw error;
  }
}

module.exports = {
  getExchangeRate,
  syncSpecificPair
};