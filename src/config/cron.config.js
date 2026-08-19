// src/config/cron.config.js
const cron = require('node-cron');
const currencyService = require('../modules/currencies/currencies.service');
const { AssetRepository } = require('../modules/assets/asset.repository');
const { AssetService } = require('../modules/assets/asset.service');
const { logger } = require('./logger.config');

// Initialize dependencies using your pattern
const assetRepo = new AssetRepository();
const assetService = new AssetService(assetRepo);

// Helper constants for fetching crypto vs fiat pairs relative to USD base
const ER_FIAT_API = 'https://open.er-api.com/v6/latest/USD';
const COINGECKO_CRYPTO_API = 'https://api.coingecko.com/api/v3/simple/price';

/**
 * Maps common asset asset codes into CoinGecko API ID string identifiers.
 * Add to this object to support more crypto tokens.
 */
const CRYPTO_ID_MAP = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'USDT': 'tether',
  'BNB': 'binancecoin',
  'SOL': 'solana'
};

function initCronJobs() {
  // ── Existing Fiat Transaction Scheduler ────────────────────────────────────
  cron.schedule('0 6 * * *', async () => {
    logger.info('[CRON_JOB]: Starting morning exchange rate synchronization...');
    try {
      await currencyService.syncSpecificPair('USD', 'PKR');
      await currencyService.syncSpecificPair('EUR', 'PKR');
      await currencyService.syncSpecificPair('GBP', 'PKR');
      logger.info('[CRON_JOB]: Morning exchange rates updated successfully.');
    } catch (error) {
      logger.error({ err: error }, `[CRON_JOB_ERROR]: Morning currency sync failed`);
    }
  });

  // ── New Asset Valuation Timeline Auto-Updater (Every Night at 1:00 AM) ──────
  cron.schedule('0 1 * * *', async () => {
    logger.info('[CRON_JOB]: Initializing asset valuation batch auto-updates...');
    const startTime = Date.now();

    try {
      // 1. Fetch all distinct active currency and crypto asset rows across the entire platform
      // This prevents pulling price updates for tokens nobody holds.
      const queryConfig = {
        name: 'get-active-cron-currencies',
        text: `
          SELECT DISTINCT currency, type 
          FROM public.assets 
          WHERE deleted_at IS NULL AND type IN ('currency', 'digital');
        `
      };
      
      // Execute via the db wrapper imported natively by your repository layers
      const requireDb = require('./db.config');
      const activeAssetsResult = await requireDb.query(queryConfig);
      
      if (activeAssetsResult.rowCount === 0) {
        logger.info('[CRON_JOB]: No active currency or digital assets found. Skipping execution.');
        return;
      }

      const activeCurrencies = activeAssetsResult.rows;

      // Split classifications into matching groups
      const fiatsToFetch = activeCurrencies.filter(a => a.type === 'currency').map(a => a.currency.toUpperCase());
      const cryptosToFetch = activeCurrencies.filter(a => a.type === 'digital').map(a => a.currency.toUpperCase());

      let fiatRates = { 'USD': 1.0 };
      let cryptoRates = {};

      // 2. Fetch fresh Fiat rates relative to USD base if any exist in portfolios
      if (fiatsToFetch.length > 0) {
        const fiatRes = await fetch(ER_FIAT_API);
        if (fiatRes.ok) {
          const data = await fiatRes.json();
          if (data.rates) fiatRates = data.rates;
        } else {
          logger.error(`[CRON_JOB_WARN]: Fiat price syncing API degraded: ${fiatRes.status}`);
        }
      }

      // 3. Fetch fresh Crypto rates relative to USD if any exist in portfolios
      const validCryptoIds = cryptosToFetch.map(ticker => CRYPTO_ID_MAP[ticker]).filter(Boolean);
      if (validCryptoIds.length > 0) {
        const cryptoUrl = `${COINGECKO_CRYPTO_API}?ids=${validCryptoIds.join(',')}&vs_currencies=usd`;
        const cryptoRes = await fetch(cryptoUrl);
        if (cryptoRes.ok) {
          cryptoRates = await cryptoRes.json();
        } else {
          logger.error(`[CRON_JOB_WARN]: Crypto price syncing API degraded: ${cryptoRes.status}`);
        }
      }

      // 4. Fetch ALL active individual assets that require updating
      const assetsQuery = {
        name: 'get-all-active-cron-assets',
        text: "SELECT id, user_id, currency, type, quantity FROM public.assets WHERE deleted_at IS NULL AND type IN ('currency', 'digital');"
      };
      const allAssets = await requireDb.query(assetsQuery);

      let processedCount = 0;

      // 5. Update valuations sequentially using your repository transaction framework
      for (const asset of allAssets.rows) {
        const ticker = asset.currency.toUpperCase();
        let priceInUsd = 0;
        let exchangeRateUsed = 1.0;

        if (asset.type === 'currency') {
          // er-api returns values as "units per 1 USD" (e.g. 1 USD = 278 PKR)
          // To get the value of 1 local unit in USD: 1 / rate
          const unitsPerUsd = fiatRates[ticker];
          if (!unitsPerUsd) continue; // Skip if currency rate cannot be matched
          
          priceInUsd = 1 / unitsPerUsd;
          exchangeRateUsed = unitsPerUsd;
        } 
        else if (asset.type === 'digital') {
          const cryptoId = CRYPTO_ID_MAP[ticker];
          if (!cryptoId || !cryptoRates[cryptoId]) continue; // Skip if ticker isn't mapped
          
          priceInUsd = cryptoRates[cryptoId].usd;
          exchangeRateUsed = 1.0; // Crypto is directly priced in baseline USD
        }

        // Calculate total valuation value in your app's base currency (USD)
        const totalValueInBaseCurrency = parseFloat(asset.quantity) * priceInUsd;

        // Persist directly to the historical tracking timeline ledger
        await assetRepo.addValuation(asset.id, {
          unit_price: priceInUsd,
          total_value_in_base_currency: totalValueInBaseCurrency,
          exchange_rate_used: exchangeRateUsed
        });

        processedCount++;
      }

      logger.info({ 
        duration_ms: Date.now() - startTime,
        records_updated: processedCount 
      }, '[CRON_JOB]: Asset valuations automation timeline updated successfully.');

    } catch (error) {
      logger.error({ err: error }, '[CRON_JOB_CRITICAL_ERROR]: Asset valuation auto-sync failed');
    }
  });

  logger.info('[CRON_SYSTEM]: Background schedulers initialized running in state: ACTIVE');
}

module.exports = { initCronJobs };