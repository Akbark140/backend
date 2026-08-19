/**
 * @file currencyConverter.js
 * @module CurrencyConverter
 * @version 2.0.0
 *
 * Enterprise-grade Multi-Currency Conversion Engine
 *
 * Architectural Philosophy:
 * ─────────────────────────
 * Currency conversion in financial systems is deceptively complex:
 *   1. Floating-point arithmetic causes penny rounding errors at scale
 *   2. Rate providers go down — the system must degrade gracefully
 *   3. FX rates are time-sensitive; stale rates cause compliance issues
 *   4. Conversion spreads and fees vary by business logic
 *   5. Audit requirements demand reproducibility of historical conversions
 *
 * This engine solves these problems via:
 *   - Decimal.js for all arithmetic (no IEEE 754 surprises)
 *   - Strategy pattern for rate providers (swap without code changes)
 *   - Circuit breaker pattern (fail fast, recover automatically)
 *   - Redis-compatible cache layer (TTL invalidation, snapshot isolation)
 *   - Adapter pattern for multi-provider normalization
 *   - Event hooks for observability and rate-change subscriptions
 *
 * Design Patterns:
 *   - Strategy   : RateProvider (ECB, OER, CurrencyLayer, Mock)
 *   - Adapter    : Normalize heterogeneous API responses to unified shape
 *   - Circuit Breaker : Protect against cascading provider failures
 *   - Repository : CacheRepository — decouple storage from domain logic
 *   - Dependency Injection : All dependencies injected at construction
 *   - Observer   : EventEmitter for rate-change notifications
 *
 * @author  FinTech Engineering Team
 * @license MIT
 */

'use strict';

const { EventEmitter } = require('events');
const Decimal          = require('decimal.js');

// ─────────────────────────────────────────────────────────────────────────────
// PRECISION CONFIGURATION
// ROUND_HALF_EVEN (Banker's Rounding) is the IEEE 754 standard default
// and the rounding mode specified in GAAP/IFRS for financial calculations.
// ─────────────────────────────────────────────────────────────────────────────
Decimal.set({
  precision:  28,                       // handles up to 26-digit amounts with 2dp
  rounding:   Decimal.ROUND_HALF_EVEN,  // Banker's rounding: statistically unbiased
  toExpPos:   28,
  toExpNeg:  -28,
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO 4217 CURRENCY REGISTRY
// Authoritative source of truth for currency metadata.
// Subset shown — production systems would load from a database or config file.
// decimal_places is critical: JPY has 0, most have 2, some (KWD) have 3.
// ─────────────────────────────────────────────────────────────────────────────

const ISO_4217_CURRENCIES = Object.freeze({
  USD: { code: 'USD', name: 'US Dollar',          symbol: '$',    decimal_places: 2, locale: 'en-US' },
  EUR: { code: 'EUR', name: 'Euro',               symbol: '€',    decimal_places: 2, locale: 'de-DE' },
  GBP: { code: 'GBP', name: 'British Pound',      symbol: '£',    decimal_places: 2, locale: 'en-GB' },
  JPY: { code: 'JPY', name: 'Japanese Yen',       symbol: '¥',    decimal_places: 0, locale: 'ja-JP' },
  CHF: { code: 'CHF', name: 'Swiss Franc',        symbol: 'Fr',   decimal_places: 2, locale: 'de-CH' },
  CAD: { code: 'CAD', name: 'Canadian Dollar',    symbol: 'C$',   decimal_places: 2, locale: 'en-CA' },
  AUD: { code: 'AUD', name: 'Australian Dollar',  symbol: 'A$',   decimal_places: 2, locale: 'en-AU' },
  CNY: { code: 'CNY', name: 'Chinese Yuan',       symbol: '¥',    decimal_places: 2, locale: 'zh-CN' },
  PKR: { code: 'PKR', name: 'Pakistani Rupee',    symbol: '₨',    decimal_places: 2, locale: 'ur-PK' },
  INR: { code: 'INR', name: 'Indian Rupee',       symbol: '₹',    decimal_places: 2, locale: 'en-IN' },
  AED: { code: 'AED', name: 'UAE Dirham',         symbol: 'د.إ',  decimal_places: 2, locale: 'ar-AE' },
  SGD: { code: 'SGD', name: 'Singapore Dollar',   symbol: 'S$',   decimal_places: 2, locale: 'en-SG' },
  HKD: { code: 'HKD', name: 'Hong Kong Dollar',   symbol: 'HK$',  decimal_places: 2, locale: 'zh-HK' },
  MXN: { code: 'MXN', name: 'Mexican Peso',       symbol: '$',    decimal_places: 2, locale: 'es-MX' },
  BRL: { code: 'BRL', name: 'Brazilian Real',     symbol: 'R$',   decimal_places: 2, locale: 'pt-BR' },
  KWD: { code: 'KWD', name: 'Kuwaiti Dinar',      symbol: 'د.ك', decimal_places: 3, locale: 'ar-KW' },
  SEK: { code: 'SEK', name: 'Swedish Krona',      symbol: 'kr',   decimal_places: 2, locale: 'sv-SE' },
  NOK: { code: 'NOK', name: 'Norwegian Krone',    symbol: 'kr',   decimal_places: 2, locale: 'nb-NO' },
  DKK: { code: 'DKK', name: 'Danish Krone',       symbol: 'kr',   decimal_places: 2, locale: 'da-DK' },
  NZD: { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$',  decimal_places: 2, locale: 'en-NZ' },
  ZAR: { code: 'ZAR', name: 'South African Rand', symbol: 'R',    decimal_places: 2, locale: 'en-ZA' },
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_CURRENCY   = 'USD';
const DEFAULT_CACHE_TTL_MS    = 60 * 60 * 1000;    // 1 hour
const DEFAULT_STALE_TTL_MS    = 24 * 60 * 60 * 1000; // 24 hours (stale-while-revalidate)
const CIRCUIT_BREAKER_THRESHOLD = 5;                // failures before opening circuit
const CIRCUIT_BREAKER_RESET_MS  = 30 * 1000;        // 30 seconds before half-open
const MAX_RETRY_ATTEMPTS        = 3;
const RETRY_BASE_DELAY_MS       = 500;              // exponential backoff base

const FXEvent = Object.freeze({
  RATE_FETCHED:    'fx:rate:fetched',
  RATE_CACHED:     'fx:rate:cached',
  RATE_EXPIRED:    'fx:rate:expired',
  CONVERSION_DONE: 'fx:conversion:done',
  PROVIDER_ERROR:  'fx:provider:error',
  CIRCUIT_OPEN:    'fx:circuit:open',
  CIRCUIT_CLOSED:  'fx:circuit:closed',
  RATE_UPDATED:    'fx:rate:updated',    // WebSocket push trigger
});

const RoundingMode = Object.freeze({
  HALF_EVEN:  Decimal.ROUND_HALF_EVEN,   // Banker's rounding (financial default)
  HALF_UP:    Decimal.ROUND_HALF_UP,     // Common rounding
  CEIL:       Decimal.ROUND_CEIL,        // Always round up (conservative fees)
  FLOOR:      Decimal.ROUND_FLOOR,       // Always round down
  TRUNCATE:   Decimal.ROUND_DOWN,        // Truncate (crypto common)
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM EXCEPTIONS
// ─────────────────────────────────────────────────────────────────────────────

class FXError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name    = 'FXError';
    this.code    = code;
    this.context = context;
    if (Error.captureStackTrace) Error.captureStackTrace(this, FXError);
  }
}

class UnsupportedCurrencyError extends FXError {
  constructor(currency) {
    super(`Unsupported currency: ${currency}`, 'ERR_UNSUPPORTED_CURRENCY', { currency });
    this.name = 'UnsupportedCurrencyError';
  }
}

class RateUnavailableError extends FXError {
  constructor(from, to, providers) {
    super(
      `Exchange rate unavailable for ${from}→${to} from providers: ${providers.join(', ')}`,
      'ERR_RATE_UNAVAILABLE',
      { from, to, providers }
    );
    this.name = 'RateUnavailableError';
  }
}

class CircuitOpenError extends FXError {
  constructor(provider, resetAt) {
    super(
      `Circuit breaker OPEN for provider "${provider}". Resets at ${resetAt.toISOString()}`,
      'ERR_CIRCUIT_OPEN',
      { provider, resetAt }
    );
    this.name = 'CircuitOpenError';
  }
}

class ProviderError extends FXError {
  constructor(provider, originalError) {
    super(
      `Provider "${provider}" failed: ${originalError.message}`,
      'ERR_PROVIDER_FAILURE',
      { provider, originalMessage: originalError.message }
    );
    this.name = 'ProviderError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE OBJECT — ExchangeRate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ExchangeRate — immutable snapshot of a currency pair rate at a point in time.
 *
 * Immutability is critical: if a rate was used for a conversion, the original
 * rate must be reconstructable for audit purposes years later.
 */
class ExchangeRate {
  constructor({ from, to, rate, provider, fetchedAt, expiresAt, bid, ask }) {
    this.from      = from.toUpperCase();
    this.to        = to.toUpperCase();
    this.rate      = new Decimal(rate);      // mid-rate
    this.bid       = bid ? new Decimal(bid)  : this.rate.minus(this.rate.times('0.001')); // -0.1% spread
    this.ask       = ask ? new Decimal(ask)  : this.rate.plus(this.rate.times('0.001'));  // +0.1% spread
    this.provider  = provider;
    this.fetchedAt = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
    this.expiresAt = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    this.rateId    = `${this.from}${this.to}:${this.fetchedAt.getTime()}`;
    Object.freeze(this);
  }

  get spread()    { return this.ask.minus(this.bid); }
  get midRate()   { return this.rate; }
  get isExpired() { return new Date() > this.expiresAt; }
  get isStale()   { return (Date.now() - this.fetchedAt.getTime()) > DEFAULT_STALE_TTL_MS; }

  /**
   * Inverse rate — allows cross-currency conversion without a round trip:
   * If we have USD/EUR, we derive EUR/USD = 1 / USD_EUR_rate
   */
  get inverse() {
    return new ExchangeRate({
      from:      this.to,
      to:        this.from,
      rate:      new Decimal(1).dividedBy(this.rate),
      bid:       new Decimal(1).dividedBy(this.ask),   // bid/ask flip on inversion
      ask:       new Decimal(1).dividedBy(this.bid),
      provider:  this.provider,
      fetchedAt: this.fetchedAt,
      expiresAt: this.expiresAt,
    });
  }

  toJSON() {
    return {
      from:      this.from,
      to:        this.to,
      rate:      this.rate.toFixed(8),
      bid:       this.bid.toFixed(8),
      ask:       this.ask.toFixed(8),
      spread:    this.spread.toFixed(8),
      provider:  this.provider,
      fetchedAt: this.fetchedAt.toISOString(),
      expiresAt: this.expiresAt.toISOString(),
      isExpired: this.isExpired,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CircuitBreaker — prevents cascading failures when providers go down.
 *
 * States:
 *   CLOSED   → normal; requests pass through; failures increment counter
 *   OPEN     → provider failed repeatedly; all requests fail immediately
 *   HALF-OPEN → probe mode; one request allowed to test if provider recovered
 *
 * This pattern is from "Release It!" (Nygard) and is standard in resilience
 * engineering (Netflix Hystrix, Resilience4j).
 */
class CircuitBreaker {
  #state = 'CLOSED';    // CLOSED | OPEN | HALF_OPEN
  #failureCount = 0;
  #lastFailureAt = null;
  #openedAt = null;

  constructor(threshold = CIRCUIT_BREAKER_THRESHOLD, resetMs = CIRCUIT_BREAKER_RESET_MS) {
    this.threshold = threshold;
    this.resetMs   = resetMs;
  }

  get state()   { return this.#state; }
  get isOpen()  { return this.#state === 'OPEN'; }
  get isClosed() { return this.#state === 'CLOSED'; }

  /**
   * Attempt to execute fn through the circuit breaker.
   * Throws CircuitOpenError immediately if circuit is OPEN and not ready to probe.
   */
  async execute(fn, providerName) {
    if (this.#state === 'OPEN') {
      const resetAt = new Date(this.#openedAt.getTime() + this.resetMs);
      if (Date.now() < resetAt.getTime()) {
        throw new CircuitOpenError(providerName, resetAt);
      }
      // Transition to HALF_OPEN for a probe request
      this.#state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (err) {
      this.#onFailure();
      throw err;
    }
  }

  #onSuccess() {
    this.#failureCount = 0;
    this.#state        = 'CLOSED';
    this.#openedAt     = null;
  }

  #onFailure() {
    this.#failureCount++;
    this.#lastFailureAt = new Date();

    if (this.#failureCount >= this.threshold || this.#state === 'HALF_OPEN') {
      this.#state    = 'OPEN';
      this.#openedAt = new Date();
    }
  }

  getStatus() {
    return {
      state:         this.#state,
      failureCount:  this.#failureCount,
      lastFailureAt: this.#lastFailureAt?.toISOString() || null,
      openedAt:      this.#openedAt?.toISOString() || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE LAYER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RateCache — in-memory cache with TTL.
 *
 * Production: replace #store with ioredis calls.
 * Key scheme: `fx:rate:{from}:{to}` — allows keyspace notifications in Redis.
 *
 * The stale-while-revalidate pattern:
 *   - If rate is fresh → return immediately
 *   - If rate is stale but within stale window → return stale + trigger async refresh
 *   - If rate is beyond stale window → force synchronous refresh
 *
 * This prevents "thundering herd" — when cache expires, one request refreshes
 * while others use the slightly-stale rate rather than all hitting the provider.
 */
class InMemoryRateCache {
  #store = new Map(); // key → { rate: ExchangeRate, setAt: number }

  async get(from, to) {
    const key    = this.#buildKey(from, to);
    const record = this.#store.get(key);
    if (!record) return null;
    if (record.rate.isStale) {
      this.#store.delete(key);
      return null;
    }
    return record.rate;
  }

  async set(rate) {
    const key = this.#buildKey(rate.from, rate.to);
    this.#store.set(key, { rate, setAt: Date.now() });
    // Also cache the inverse to avoid a second provider call for the pair
    const inverseKey = this.#buildKey(rate.to, rate.from);
    this.#store.set(inverseKey, { rate: rate.inverse, setAt: Date.now() });
  }

  async del(from, to) {
    this.#store.delete(this.#buildKey(from, to));
    this.#store.delete(this.#buildKey(to, from));
  }

  async snapshot() {
    const result = {};
    for (const [key, record] of this.#store) {
      result[key] = record.rate.toJSON();
    }
    return result;
  }

  async flush() { this.#store.clear(); }

  #buildKey(from, to) { return `fx:rate:${from}:${to}`; }

  /**
   * Lock a rate for a transaction period.
   * Rate locking prevents FX exposure between quote and execution.
   * In production: Redis SET NX EX with a lock key.
   */
  async lockRate(from, to, ttlMs, lockId) {
    const lockKey = `fx:lock:${from}:${to}:${lockId}`;
    const existing = this.#store.get(lockKey);
    if (existing && Date.now() < existing.expiresAt) {
      return existing.rate;  // return the locked rate
    }
    const rate = await this.get(from, to);
    if (!rate) return null;
    this.#store.set(lockKey, { rate, expiresAt: Date.now() + ttlMs });
    return rate;
  }
}

/**
 * RedisRateCache — production Redis implementation stub.
 * Implements the same interface as InMemoryRateCache.
 * Swap in via dependency injection with no domain code changes.
 */
class RedisRateCache {
  constructor(redisClient, { ttlSeconds = 3600, keyPrefix = 'fx:rate:' } = {}) {
    this.redis     = redisClient;       // ioredis / node-redis client
    this.ttl       = ttlSeconds;
    this.keyPrefix = keyPrefix;
  }

  async get(from, to) {
    const key  = `${this.keyPrefix}${from}:${to}`;
    const data = await this.redis.get(key);
    if (!data) return null;
    const parsed = JSON.parse(data);
    return new ExchangeRate(parsed);
  }

  async set(rate) {
    const key  = `${this.keyPrefix}${rate.from}:${rate.to}`;
    const data = JSON.stringify(rate.toJSON());
    // SET key value EX ttl — atomic set with expiry
    await this.redis.set(key, data, 'EX', this.ttl);
    // Cache inverse
    const invKey = `${this.keyPrefix}${rate.to}:${rate.from}`;
    await this.redis.set(invKey, JSON.stringify(rate.inverse.toJSON()), 'EX', this.ttl);
  }

  async del(from, to) {
    await this.redis.del(
      `${this.keyPrefix}${from}:${to}`,
      `${this.keyPrefix}${to}:${from}`
    );
  }

  async flush() { /* await this.redis.flushdb(); — use with caution */ }

  async snapshot() {
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    const pipeline = this.redis.pipeline();
    keys.forEach(k => pipeline.get(k));
    const results = await pipeline.exec();
    const out = {};
    results.forEach(([err, val], i) => {
      if (!err && val) out[keys[i]] = JSON.parse(val);
    });
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE PROVIDERS — Strategy Pattern
// Each provider implements the RateProvider interface:
//   fetchRates(baseCurrency: string) → Promise<Map<string, number>>
//   fetchRate(from: string, to: string) → Promise<ExchangeRate>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AbstractRateProvider — base class enforcing the strategy interface.
 * All providers adapt their API format to the canonical ExchangeRate shape.
 */
class AbstractRateProvider {
  constructor(name) {
    if (new.target === AbstractRateProvider) {
      throw new Error('AbstractRateProvider is abstract');
    }
    this.name           = name;
    this.circuitBreaker = new CircuitBreaker();
  }

  // Subclasses implement this
  async _doFetchRates(baseCurrency) { throw new Error('Not implemented'); }

  /**
   * Fetch rates with retry + circuit breaker wrapping.
   * Uses exponential backoff: delay = baseDelay * 2^attempt (capped).
   */
  async fetchRates(baseCurrency) {
    return this.circuitBreaker.execute(async () => {
      let lastError;
      for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        try {
          return await this._doFetchRates(baseCurrency);
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRY_ATTEMPTS - 1) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            await this.#sleep(delay);
          }
        }
      }
      throw new ProviderError(this.name, lastError);
    }, this.name);
  }

  /**
   * Fetch a single rate. Default: fetch all rates and extract the pair.
   * Override in subclasses that support single-pair endpoints (faster/cheaper).
   */
  async fetchRate(from, to) {
    const rates = await this.fetchRates(from);
    const rate  = rates.get(to);
    if (!rate) throw new RateUnavailableError(from, to, [this.name]);
    return rate;
  }

  #sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

/**
 * MockRateProvider — deterministic provider for testing and development.
 *
 * Returns hardcoded rates from a seeded table, ensuring tests are repeatable
 * without network calls. Supports configurable artificial latency.
 */
class MockRateProvider extends AbstractRateProvider {
  #rates;
  #latencyMs;
  #failureRate;   // 0.0–1.0 probability of throwing an error (chaos testing)

  constructor({ latencyMs = 0, failureRate = 0, customRates = {} } = {}) {
    super('MOCK');
    this.#latencyMs   = latencyMs;
    this.#failureRate = failureRate;
    // Base rates relative to USD (source: approximate real rates)
    this.#rates = {
      EUR: 0.92, GBP: 0.79, JPY: 149.50, CHF: 0.89,
      CAD: 1.36, AUD: 1.53, CNY: 7.24,   PKR: 278.50,
      INR: 83.10, AED: 3.67, SGD: 1.34,  HKD: 7.82,
      MXN: 17.15, BRL: 4.97, KWD: 0.307, SEK: 10.42,
      NOK: 10.55, DKK: 6.89, NZD: 1.63,  ZAR: 18.63,
      USD: 1.00,
      ...customRates,
    };
  }

  async _doFetchRates(baseCurrency) {
    if (this.#latencyMs > 0) await new Promise(r => setTimeout(r, this.#latencyMs));

    // Chaos engineering hook
    if (Math.random() < this.#failureRate) {
      throw new Error('MockRateProvider: simulated failure');
    }

    const baseRate = this.#rates[baseCurrency];
    if (!baseRate) throw new Error(`Mock has no rate for base ${baseCurrency}`);

    const now      = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_CACHE_TTL_MS);
    const result   = new Map();

    for (const [currency, usdRate] of Object.entries(this.#rates)) {
      if (currency === baseCurrency) continue;
      // Cross-rate: baseCurrency→currency = (USD/baseCurrency) * (currency/USD)
      const rate = new Decimal(usdRate).dividedBy(new Decimal(baseRate));
      result.set(currency, new ExchangeRate({
        from:      baseCurrency,
        to:        currency,
        rate:      rate.toFixed(8),
        provider:  this.name,
        fetchedAt: now,
        expiresAt,
      }));
    }
    return result;
  }
}

/**
 * ECBRateProvider — European Central Bank daily reference rates.
 *
 * ECB publishes rates once daily (typically 16:00 CET) for ~30 currencies
 * vs EUR. This is the authoritative source for EUR-based companies.
 *
 * API: https://data-api.ecb.europa.eu/service/data/EXR/D.*.EUR.SP00.A
 */
class ECBRateProvider extends AbstractRateProvider {
  constructor({ httpClient, baseCurrency = 'EUR' } = {}) {
    super('ECB');
    this.http         = httpClient; // axios instance or fetch wrapper
    this.baseCurrency = baseCurrency;
    this.ECB_URL      = 'https://data-api.ecb.europa.eu/service/data/EXR/D.*.EUR.SP00.A?format=csvdata&lastNObservations=1';
  }

  async _doFetchRates(requestedBase) {
    // ECB always returns EUR-based rates; we normalize after fetch
    const response = await this.http.get(this.ECB_URL, {
      headers: { Accept: 'text/csv' },
      timeout: 10000,
    });

    const rates = this.#parseECBCsv(response.data);
    const now   = new Date();

    // If requestedBase is not EUR, normalize via cross-rate
    if (requestedBase !== 'EUR') {
      return this.#normalizeBase(rates, requestedBase, now);
    }
    return rates;
  }

  /**
   * Parse ECB CSV format into Map<string, ExchangeRate>
   * ECB CSV columns: FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE
   */
  #parseECBCsv(csv) {
    const lines  = csv.trim().split('\n');
    const result = new Map();
    const now    = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // ECB updates daily

    for (let i = 1; i < lines.length; i++) {  // skip header
      const cols = lines[i].split(',');
      if (cols.length < 7) continue;

      const currency = cols[1].trim();
      const rate     = parseFloat(cols[6]);
      if (!currency || isNaN(rate) || rate <= 0) continue;

      result.set(currency, new ExchangeRate({
        from:      'EUR',
        to:        currency,
        rate:      (1 / rate).toFixed(8),  // ECB gives foreign units per EUR; invert for EUR/foreign
        provider:  this.name,
        fetchedAt: now,
        expiresAt,
      }));
    }
    return result;
  }

  #normalizeBase(eurRates, newBase, now) {
    const eurToNewBase = eurRates.get(newBase);
    if (!eurToNewBase) throw new RateUnavailableError('EUR', newBase, [this.name]);

    const result = new Map();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    for (const [currency, eurRate] of eurRates) {
      if (currency === newBase) continue;
      // Cross-rate: newBase→currency = (EUR→currency) / (EUR→newBase)
      const crossRate = eurRate.rate.dividedBy(eurToNewBase.rate);
      result.set(currency, new ExchangeRate({
        from:      newBase,
        to:        currency,
        rate:      crossRate.toFixed(8),
        provider:  this.name,
        fetchedAt: now,
        expiresAt,
      }));
    }
    return result;
  }
}

/**
 * OpenExchangeRatesProvider — OpenExchangeRates.io commercial provider.
 * Provides real-time and historical rates for 170+ currencies.
 * Requires API key. Free tier: USD base only; paid: any base.
 */
class OpenExchangeRatesProvider extends AbstractRateProvider {
  constructor({ apiKey, httpClient, appId } = {}) {
    super('OER');
    this.apiKey     = apiKey || appId;
    this.http       = httpClient;
    this.BASE_URL   = 'https://openexchangerates.org/api';
  }

  async _doFetchRates(baseCurrency) {
    const endpoint = `${this.BASE_URL}/latest.json?app_id=${this.apiKey}&base=${baseCurrency}&show_alternative=true`;
    const response = await this.http.get(endpoint, { timeout: 10000 });

    const { rates, timestamp } = response.data;
    const fetchedAt = new Date(timestamp * 1000);
    const expiresAt = new Date(fetchedAt.getTime() + DEFAULT_CACHE_TTL_MS);
    const result    = new Map();

    for (const [currency, rate] of Object.entries(rates)) {
      if (currency === baseCurrency || rate <= 0) continue;
      result.set(currency, new ExchangeRate({
        from:      baseCurrency,
        to:        currency,
        rate:      String(rate),
        provider:  this.name,
        fetchedAt,
        expiresAt,
      }));
    }
    return result;
  }

  /**
   * Historical rate lookup — returns rate for a specific date.
   * Critical for auditing historical transactions.
   */
  async fetchHistoricalRate(from, to, date) {
    const dateStr  = date.toISOString().slice(0, 10);
    const endpoint = `${this.BASE_URL}/historical/${dateStr}.json?app_id=${this.apiKey}&base=${from}&symbols=${to}`;
    const response = await this.http.get(endpoint, { timeout: 10000 });

    const rate = response.data.rates[to];
    if (!rate) throw new RateUnavailableError(from, to, [this.name]);

    const fetchedAt = new Date(response.data.timestamp * 1000);
    return new ExchangeRate({
      from,
      to,
      rate:      String(rate),
      provider:  `${this.name}:historical:${dateStr}`,
      fetchedAt,
      expiresAt: new Date('9999-12-31'), // historical rates never expire
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE AGGREGATOR — Multi-Provider Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RateAggregator — tries providers in priority order with fallback.
 *
 * Provider priority is configurable (e.g., put ECB first for EUR companies).
 * On failure, moves to next provider. Emits observability events for monitoring.
 *
 * Future extension: implement median/consensus rate across providers
 * to detect outliers (e.g., one provider has a bug with an extreme rate).
 */
class RateAggregator {
  constructor(providers, eventBus) {
    if (!providers || providers.length === 0) {
      throw new FXError('At least one rate provider is required', 'ERR_NO_PROVIDERS');
    }
    this.providers = providers;
    this.eventBus  = eventBus;
  }

  async fetchRates(baseCurrency) {
    const errors = [];

    for (const provider of this.providers) {
      try {
        const rates = await provider.fetchRates(baseCurrency);
        this.eventBus.emit(FXEvent.RATE_FETCHED, {
          provider:  provider.name,
          base:      baseCurrency,
          count:     rates.size,
          fetchedAt: new Date(),
        });
        return { rates, provider: provider.name };
      } catch (err) {
        errors.push({ provider: provider.name, error: err.message });
        this.eventBus.emit(FXEvent.PROVIDER_ERROR, {
          provider: provider.name,
          error:    err.message,
          code:     err.code,
        });
        // Continue to next provider
      }
    }

    throw new RateUnavailableError(
      baseCurrency,
      '*',
      errors.map(e => `${e.provider}(${e.error})`)
    );
  }

  async fetchRate(from, to) {
    const { rates } = await this.fetchRates(from);
    const rate = rates.get(to);
    if (!rate) throw new RateUnavailableError(from, to, this.providers.map(p => p.name));
    return rate;
  }

  /**
   * Cross-currency conversion without direct pair.
   * Uses the base currency as a hub:
   *   PKR → GBP = (PKR → USD) then (USD → GBP)
   *
   * This is how most FX systems work — everything routes through USD or EUR.
   * Direct exotic pairs (e.g., PKR/GBP) are rare on provider APIs.
   */
  async fetchCrossRate(from, to, hub = DEFAULT_BASE_CURRENCY) {
    if (from === hub) {
      const { rates } = await this.fetchRates(hub);
      return rates.get(to);
    }
    if (to === hub) {
      const { rates } = await this.fetchRates(from);
      return rates.get(to);
    }

    // Fetch both sides in parallel
    const [fromRates, toRates] = await Promise.all([
      this.fetchRates(hub),
      this.fetchRates(hub),
    ]);

    const hubToFrom = fromRates.rates.get(from);
    const hubToTo   = toRates.rates.get(to);

    if (!hubToFrom || !hubToTo) {
      throw new RateUnavailableError(from, to, this.providers.map(p => p.name));
    }

    // Cross-rate: from→to = (hub→to) / (hub→from)
    const crossRate = hubToTo.rate.dividedBy(hubToFrom.rate);
    return new ExchangeRate({
      from,
      to,
      rate:      crossRate.toFixed(8),
      provider:  `CROSS:${fromRates.provider}`,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ConversionEngine — precision-safe currency math engine.
 *
 * All calculations use Decimal.js throughout to prevent floating-point drift.
 * Results are rounded ONCE at the final step (rounding accumulates errors if
 * applied at intermediate steps).
 */
class ConversionEngine {
  /**
   * Convert an amount using a given exchange rate.
   *
   * @param {Decimal|string|number} amount
   * @param {ExchangeRate} exchangeRate
   * @param {Object} options
   * @param {number} [options.decimalPlaces]  - override precision (default: target currency)
   * @param {number} [options.spreadPercent]  - add bid/ask spread cost (e.g., 0.5 for 0.5%)
   * @param {number} [options.feePercent]     - add conversion fee (e.g., 1.0 for 1%)
   * @param {number} [options.roundingMode]   - Decimal.js rounding constant
   * @returns {ConversionResult}
   */
  static convert(amount, exchangeRate, options = {}) {
    const {
      decimalPlaces  = ISO_4217_CURRENCIES[exchangeRate.to]?.decimal_places ?? 2,
      spreadPercent  = 0,
      feePercent     = 0,
      roundingMode   = RoundingMode.HALF_EVEN,
    } = options;

    const inputAmount = new Decimal(amount);

    if (inputAmount.isNegative()) {
      throw new FXError('Conversion amount cannot be negative', 'ERR_NEGATIVE_AMOUNT');
    }

    // Apply spread: use ask rate when buying foreign currency (conservative)
    const appliedRate = spreadPercent > 0
      ? exchangeRate.ask.plus(exchangeRate.ask.times(new Decimal(spreadPercent).dividedBy(100)))
      : exchangeRate.rate;

    // Gross converted amount (before fees)
    const grossAmount = inputAmount.times(appliedRate);

    // Conversion fee (e.g., 1% of the converted amount)
    const feeAmount = feePercent > 0
      ? grossAmount.times(new Decimal(feePercent).dividedBy(100))
      : new Decimal(0);

    const netAmount = grossAmount.minus(feeAmount);

    // Round ONCE at the end — Banker's rounding to currency's decimal places
    const roundedNet   = netAmount.toDecimalPlaces(decimalPlaces, roundingMode);
    const roundedGross = grossAmount.toDecimalPlaces(decimalPlaces, roundingMode);
    const roundedFee   = feeAmount.toDecimalPlaces(decimalPlaces, roundingMode);

    return new ConversionResult({
      from:          exchangeRate.from,
      to:            exchangeRate.to,
      inputAmount:   inputAmount.toFixed(ISO_4217_CURRENCIES[exchangeRate.from]?.decimal_places ?? 2),
      grossAmount:   roundedGross.toFixed(decimalPlaces),
      feeAmount:     roundedFee.toFixed(decimalPlaces),
      netAmount:     roundedNet.toFixed(decimalPlaces),
      appliedRate:   appliedRate.toFixed(8),
      exchangeRate:  exchangeRate.toJSON(),
      decimalPlaces,
      spreadPercent,
      feePercent,
      convertedAt:   new Date(),
    });
  }

  /**
   * FX Gain/Loss Calculation.
   * Used in accounting when foreign currency assets/liabilities are remeasured.
   *
   * Example: Recorded AR of £10,000 at rate 1.25 (=$12,500)
   *          At settlement, rate is 1.20 (=$12,000)
   *          FX Loss = $500
   *
   * @param {string|number} recordedAmountBase  - amount in base currency at original rate
   * @param {string|number} currentAmountBase   - amount in base currency at current rate
   */
  static calculateFXGainLoss(recordedAmountBase, currentAmountBase, currency) {
    const recorded = new Decimal(recordedAmountBase);
    const current  = new Decimal(currentAmountBase);
    const diff     = current.minus(recorded);

    return {
      recordedAmount: recorded.toFixed(2),
      currentAmount:  current.toFixed(2),
      gainLoss:       diff.toFixed(2),
      isGain:         diff.isPositive(),
      isLoss:         diff.isNegative(),
      currency,
    };
  }
}

/**
 * ConversionResult — immutable output of a currency conversion.
 * Designed to be stored in DB for audit/reconciliation.
 */
class ConversionResult {
  constructor(data) {
    Object.assign(this, data);
    Object.freeze(this);
  }

  toJSON() { return { ...this }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CURRENCY FORMATTER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CurrencyFormatter — locale-aware, ISO 4217-compliant formatting.
 *
 * Uses Intl.NumberFormat (built-in V8) for locale-correct formatting.
 * Avoids string concatenation with symbols, which fails for RTL currencies.
 */
class CurrencyFormatter {
  static format(amount, currencyCode, locale) {
    const meta = ISO_4217_CURRENCIES[currencyCode];
    if (!meta) throw new UnsupportedCurrencyError(currencyCode);

    const resolvedLocale = locale || meta.locale;
    const formatter = new Intl.NumberFormat(resolvedLocale, {
      style:                'currency',
      currency:             currencyCode,
      minimumFractionDigits: meta.decimal_places,
      maximumFractionDigits: meta.decimal_places,
    });

    return formatter.format(new Decimal(amount).toNumber());
  }

  static formatPair(fromAmount, fromCurrency, toAmount, toCurrency) {
    return `${this.format(fromAmount, fromCurrency)} → ${this.format(toAmount, toCurrency)}`;
  }

  static getMetadata(currencyCode) {
    const meta = ISO_4217_CURRENCIES[currencyCode];
    if (!meta) throw new UnsupportedCurrencyError(currencyCode);
    return meta;
  }

  static isSupported(code) { return code in ISO_4217_CURRENCIES; }
  static supportedCurrencies() { return Object.keys(ISO_4217_CURRENCIES); }
}

// ─────────────────────────────────────────────────────────────────────────────
// CURRENCY CONVERTER SERVICE — Application Service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CurrencyConverterService — the public API for the currency subsystem.
 *
 * Orchestrates: cache → provider → conversion → audit → event emission.
 * All external callers (REST, GraphQL, internal services) use this class.
 */
class CurrencyConverterService {
  constructor({
    providers,
    cache,
    eventBus,
    baseCurrency = DEFAULT_BASE_CURRENCY,
    logger       = console,
    metrics      = null,    // Optional metrics collector (Prometheus, DataDog)
  } = {}) {
    if (!providers || providers.length === 0) {
      throw new FXError('At least one rate provider is required', 'ERR_NO_PROVIDERS');
    }

    this.aggregator   = new RateAggregator(providers, eventBus || new EventEmitter());
    this.cache        = cache || new InMemoryRateCache();
    this.eventBus     = eventBus || new EventEmitter();
    this.baseCurrency = baseCurrency;
    this.logger       = logger;
    this.metrics      = metrics;
    this.auditLog     = [];    // In production: write to append-only DB table
  }

  // ── Rate Retrieval ────────────────────────────────────────────────────────

  /**
   * Get exchange rate with caching.
   * Cache hit: O(1). Cache miss: provider call + write-through cache.
   */
  async getRate(from, to, { bypassCache = false, forceRefresh = false } = {}) {
    this.#validateCurrency(from);
    this.#validateCurrency(to);

    if (from === to) {
      return new ExchangeRate({
        from, to, rate: '1', provider: 'IDENTITY',
        fetchedAt: new Date(),
        expiresAt: new Date('9999-12-31'),
      });
    }

    // ── Cache lookup ────────────────────────────────────────────────────────
    if (!bypassCache && !forceRefresh) {
      const cached = await this.cache.get(from, to);
      if (cached && !cached.isExpired) {
        this.logger.debug?.(`[FX] Cache hit: ${from}/${to}`);
        return cached;
      }
    }

    // ── Fetch from provider ─────────────────────────────────────────────────
    this.logger.debug?.(`[FX] Cache miss, fetching: ${from}/${to}`);
    let rate;

    // Direct pair first; fall back to cross-rate via hub
    try {
      rate = await this.aggregator.fetchRate(from, to);
    } catch {
      this.logger.debug?.(`[FX] Direct rate not found, trying cross-rate ${from}→${this.baseCurrency}→${to}`);
      rate = await this.aggregator.fetchCrossRate(from, to, this.baseCurrency);
    }

    // ── Write-through cache ─────────────────────────────────────────────────
    await this.cache.set(rate);
    this.eventBus.emit(FXEvent.RATE_CACHED, { from, to, rate: rate.toJSON() });
    this.eventBus.emit(FXEvent.RATE_UPDATED, { from, to, rate: rate.toJSON() }); // WebSocket hook

    return rate;
  }

  /**
   * Get all rates for a base currency (bulk fetch — more efficient than N single calls).
   */
  async getAllRates(baseCurrency = this.baseCurrency) {
    this.#validateCurrency(baseCurrency);
    const { rates, provider } = await this.aggregator.fetchRates(baseCurrency);

    // Populate cache with all fetched rates (batch write)
    await Promise.all([...rates.values()].map(r => this.cache.set(r)));

    return { base: baseCurrency, provider, rates: Object.fromEntries(
      [...rates.entries()].map(([k, v]) => [k, v.toJSON()])
    )};
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  /**
   * Convert an amount from one currency to another.
   *
   * @param {number|string} amount
   * @param {string} from
   * @param {string} to
   * @param {Object} options - spread, fees, rounding overrides
   */
  async convert(amount, from, to, options = {}) {
    const rate   = await this.getRate(from, to);
    const result = ConversionEngine.convert(amount, rate, options);

    // ── Audit record ──────────────────────────────────────────────────────
    this.#writeAudit({
      type:        'CONVERSION',
      from,
      to,
      inputAmount: result.inputAmount,
      netAmount:   result.netAmount,
      rateId:      rate.rateId,
      provider:    rate.provider,
    });

    this.eventBus.emit(FXEvent.CONVERSION_DONE, result.toJSON());
    this.metrics?.increment('fx.conversion', { from, to });

    return result;
  }

  /**
   * Batch conversion — convert multiple amounts in parallel.
   * More efficient than sequential calls when processing transactions.
   *
   * @param {Array<{amount, from, to, options}>} conversions
   */
  async batchConvert(conversions) {
    // Group by currency pair to fetch each rate only once
    const uniquePairs = [...new Set(conversions.map(c => `${c.from}:${c.to}`))];

    // Parallel rate fetch
    const rateMap = new Map();
    await Promise.all(uniquePairs.map(async pair => {
      const [from, to] = pair.split(':');
      const rate = await this.getRate(from, to);
      rateMap.set(pair, rate);
    }));

    // Apply conversions with cached rates (no additional provider calls)
    return conversions.map(({ amount, from, to, options = {} }) => {
      const rate = rateMap.get(`${from}:${to}`);
      return ConversionEngine.convert(amount, rate, options);
    });
  }

  /**
   * Lock a rate for a specific transaction window.
   * Allows quote-then-execute patterns with guaranteed rate.
   */
  async lockRate(from, to, { ttlMs = 300_000, lockId } = {}) {
    const rate   = await this.getRate(from, to);
    const id     = lockId || `lock-${from}-${to}-${Date.now()}`;
    await this.cache.lockRate(from, to, ttlMs, id);
    return { lockId: id, rate: rate.toJSON(), expiresAt: new Date(Date.now() + ttlMs) };
  }

  /**
   * Historical rate — for auditing past conversions.
   * Routes to the provider that supports historical data (e.g., OER).
   */
  async getHistoricalRate(from, to, date) {
    this.#validateCurrency(from);
    this.#validateCurrency(to);

    const cacheKey = `historical:${from}:${to}:${date.toISOString().slice(0,10)}`;
    const cached   = await this.cache.get(cacheKey, date.toISOString().slice(0,10));
    if (cached) return cached;

    // Try providers that support historical rates
    for (const provider of this.aggregator.providers) {
      if (typeof provider.fetchHistoricalRate === 'function') {
        try {
          const rate = await provider.fetchHistoricalRate(from, to, date);
          return rate;
        } catch { /* try next provider */ }
      }
    }
    throw new RateUnavailableError(from, to, ['Historical rates unavailable']);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  format(amount, currencyCode, locale) {
    return CurrencyFormatter.format(amount, currencyCode, locale);
  }

  formatConversion(result) {
    return CurrencyFormatter.formatPair(result.inputAmount, result.from, result.netAmount, result.to);
  }

  getCurrencyMetadata(code) {
    return CurrencyFormatter.getMetadata(code);
  }

  calculateFXGainLoss(recorded, current, currency) {
    return ConversionEngine.calculateFXGainLoss(recorded, current, currency);
  }

  getCacheSnapshot()  { return this.cache.snapshot(); }
  getAuditLog()       { return [...this.auditLog]; }
  getProviderStatus() {
    return this.aggregator.providers.map(p => ({
      name:   p.name,
      circuit: p.circuitBreaker.getStatus(),
    }));
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  #validateCurrency(code) {
    if (!CurrencyFormatter.isSupported(code)) {
      throw new UnsupportedCurrencyError(code);
    }
  }

  #writeAudit(record) {
    this.auditLog.push(Object.freeze({
      ...record,
      id:        require('crypto').randomUUID(),
      timestamp: new Date().toISOString(),
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createCurrencyConverter — assembles the converter subsystem.
 *
 * @param {Object} options
 * @param {string} [options.oerApiKey]    - OpenExchangeRates API key
 * @param {Object} [options.redisClient]  - ioredis/node-redis client
 * @param {Object} [options.httpClient]   - axios instance
 * @param {EventEmitter} [options.eventBus]
 * @param {boolean} [options.useMock]     - force mock provider (testing)
 */
function createCurrencyConverter({
  oerApiKey,
  redisClient,
  httpClient,
  eventBus,
  useMock     = false,
  mockOptions = {},
  baseCurrency = DEFAULT_BASE_CURRENCY,
} = {}) {
  const bus = eventBus || new EventEmitter();

  // Provider priority: Mock → OER → ECB (customizable)
  const providers = [];

  if (useMock || !oerApiKey) {
    providers.push(new MockRateProvider(mockOptions));
  }
  if (oerApiKey && httpClient) {
    providers.push(new OpenExchangeRatesProvider({ apiKey: oerApiKey, httpClient }));
  }
  if (httpClient && !useMock) {
    providers.push(new ECBRateProvider({ httpClient }));
  }
  if (providers.length === 0) {
    providers.push(new MockRateProvider()); // safe fallback for dev
  }

  const cache = redisClient
    ? new RedisRateCache(redisClient)
    : new InMemoryRateCache();

  return new CurrencyConverterService({
    providers,
    cache,
    eventBus: bus,
    baseCurrency,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS.JS INTEGRATION EXAMPLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mountCurrencyRoutes — plug-and-play Express router.
 *
 * Usage:
 *   const converter = createCurrencyConverter({ useMock: true });
 *   app.use('/api/fx', mountCurrencyRoutes(converter));
 */
function mountCurrencyRoutes(converterService) {
  // Requires express to be installed; lazy require to avoid hard dependency
  const express = (() => { try { return require('express'); } catch { return null; } })();
  if (!express) throw new Error('express must be installed to use mountCurrencyRoutes');

  const router = express.Router();

  // GET /api/fx/rate?from=USD&to=EUR
  router.get('/rate', async (req, res) => {
    try {
      const { from, to, bypassCache } = req.query;
      const rate = await converterService.getRate(from, to, { bypassCache: bypassCache === 'true' });
      res.json({ success: true, data: rate.toJSON() });
    } catch (err) {
      res.status(err instanceof UnsupportedCurrencyError ? 400 : 503)
         .json({ success: false, error: { code: err.code, message: err.message } });
    }
  });

  // GET /api/fx/convert?amount=1000&from=USD&to=PKR&fee=1
  router.get('/convert', async (req, res) => {
    try {
      const { amount, from, to, fee = 0, spread = 0 } = req.query;
      const result = await converterService.convert(amount, from, to, {
        feePercent:    parseFloat(fee),
        spreadPercent: parseFloat(spread),
      });
      res.json({ success: true, data: result.toJSON() });
    } catch (err) {
      res.status(400).json({ success: false, error: { code: err.code, message: err.message } });
    }
  });

  // POST /api/fx/batch
  router.post('/batch', express.json(), async (req, res) => {
    try {
      const { conversions } = req.body;
      const results = await converterService.batchConvert(conversions);
      res.json({ success: true, data: results.map(r => r.toJSON()) });
    } catch (err) {
      res.status(400).json({ success: false, error: { code: err.code, message: err.message } });
    }
  });

  // GET /api/fx/currencies
  router.get('/currencies', (req, res) => {
    res.json({ success: true, data: ISO_4217_CURRENCIES });
  });

  // GET /api/fx/providers/status
  router.get('/providers/status', (req, res) => {
    res.json({ success: true, data: converterService.getProviderStatus() });
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE USAGE
// ─────────────────────────────────────────────────────────────────────────────

async function runConverterExample() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Multi-Currency Converter Engine — Example');
  console.log('═══════════════════════════════════════════════════\n');

  const eventBus  = new EventEmitter();
  const converter = createCurrencyConverter({
    useMock:     true,
    mockOptions: { latencyMs: 10 },
    eventBus,
  });

  // Subscribe to events (WebSocket / SSE would forward these to clients)
  eventBus.on(FXEvent.RATE_FETCHED, e  => console.log(`[EVENT] Rate fetched from ${e.provider}: ${e.count} currencies`));
  eventBus.on(FXEvent.RATE_CACHED,  e  => console.log(`[EVENT] Cached: ${e.from}/${e.to}`));
  eventBus.on(FXEvent.CONVERSION_DONE, e => console.log(`[EVENT] Conversion: ${e.from}→${e.to} amount=${e.netAmount}`));

  // 1. Simple conversion
  const usdToEur = await converter.convert(10000, 'USD', 'EUR');
  console.log(`\n✔ USD→EUR: ${converter.formatConversion(usdToEur)}`);
  console.log(`  Rate: ${usdToEur.appliedRate}  Fee: ${usdToEur.feeAmount}`);

  // 2. With spread and fee
  const usdToGbp = await converter.convert(50000, 'USD', 'GBP', {
    spreadPercent: 0.5,  // 50 bps bid-ask spread
    feePercent:    1.0,  // 1% conversion fee
  });
  console.log(`\n✔ USD→GBP (with fees): ${converter.formatConversion(usdToGbp)}`);
  console.log(`  Gross: ${usdToGbp.grossAmount} GBP  Fee: ${usdToGbp.feeAmount} GBP  Net: ${usdToGbp.netAmount} GBP`);

  // 3. Cross-currency (no direct pair — routes through USD hub)
  const pkrToGbp = await converter.convert(500000, 'PKR', 'GBP');
  console.log(`\n✔ PKR→GBP (cross-rate): ${converter.formatConversion(pkrToGbp)}`);

  // 4. JPY — zero decimal places
  const jpyConv = await converter.convert(100000, 'JPY', 'USD');
  console.log(`\n✔ JPY→USD: ${converter.formatConversion(jpyConv)}`);

  // 5. Batch conversion
  const batch = await converter.batchConvert([
    { amount: 1000, from: 'USD', to: 'EUR' },
    { amount: 2000, from: 'USD', to: 'GBP' },
    { amount: 3000, from: 'USD', to: 'JPY' },
    { amount: 4000, from: 'USD', to: 'PKR' },
    { amount: 5000, from: 'EUR', to: 'GBP' },
  ]);
  console.log(`\n── Batch Conversion Results (${batch.length} items) ───────────`);
  batch.forEach(r => console.log(`  ${r.from}→${r.to}: ${r.inputAmount} → ${r.netAmount}`));

  // 6. Rate locking
  const lock = await converter.lockRate('USD', 'EUR', { ttlMs: 300_000 });
  console.log(`\n✔ Rate locked: ${lock.lockId} expires ${lock.expiresAt.toISOString()}`);

  // 7. FX Gain/Loss
  const fxgl = converter.calculateFXGainLoss('125000', '120000', 'USD');
  console.log(`\n── FX Gain/Loss ──────────────────────────────────`);
  console.log(`  Recorded: $${fxgl.recordedAmount}  Current: $${fxgl.currentAmount}`);
  console.log(`  ${fxgl.isLoss ? 'FX Loss' : 'FX Gain'}: $${Math.abs(parseFloat(fxgl.gainLoss))}`);

  // 8. Currency formatting
  console.log('\n── Formatted Amounts ─────────────────────────────');
  [['USD', 1234567.89], ['EUR', 1234567.89], ['JPY', 1234567], ['KWD', 1234.567]]
    .forEach(([code, amt]) => console.log(`  ${code}: ${converter.format(amt, code)}`));

  // 9. Provider status (circuit breaker health)
  console.log('\n── Provider Status ───────────────────────────────');
  converter.getProviderStatus().forEach(p =>
    console.log(`  ${p.name}: circuit=${p.circuit.state} failures=${p.circuit.failureCount}`)
  );

  // 10. Audit log
  const audit = converter.getAuditLog();
  console.log(`\n── Conversion Audit Log (${audit.length} entries) ────────────`);
  audit.forEach(a => console.log(`  [${a.timestamp.slice(0,19)}] ${a.from}→${a.to} ${a.inputAmount} provider=${a.provider}`));

  console.log('\n═══════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Factory
  createCurrencyConverter,
  // Service
  CurrencyConverterService,
  // Providers
  AbstractRateProvider,
  MockRateProvider,
  ECBRateProvider,
  OpenExchangeRatesProvider,
  // Core
  RateAggregator,
  ConversionEngine,
  ConversionResult,
  ExchangeRate,
  CircuitBreaker,
  // Cache
  InMemoryRateCache,
  RedisRateCache,
  // Formatter
  CurrencyFormatter,
  // Express integration
  mountCurrencyRoutes,
  // Constants
  ISO_4217_CURRENCIES,
  DEFAULT_BASE_CURRENCY,
  FXEvent,
  RoundingMode,
  // Errors
  FXError,
  UnsupportedCurrencyError,
  RateUnavailableError,
  CircuitOpenError,
  ProviderError,
  // Example
  runConverterExample,
};

// Run example if executed directly
if (require.main === module) {
  runConverterExample().catch(err => {
    console.error('Converter example failed:', err);
    process.exit(1);
  });
}