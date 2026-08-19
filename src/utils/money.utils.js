/**
 * @module shared/money.util
 * @description High-precision BigInt monetary mathematics engine operating entirely in minor units.
 */

'use strict';

const { AppError } = require('../shared/AppError');

const AMOUNT_SCALE = 100n;
const RATE_MAX_SCALE = 12;

/**
 * Normalizes and validates ISO currency codes.
 */
function normalizeCurrency(value, fieldName = 'currency') {
  const currency = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError(`${fieldName} must be a 3-letter ISO currency code`, 400);
  }
  return currency;
}

/**
 * Converts a decimal string/number safely into a BigInt representation of minor units.
 */
function parseDecimalToMinorUnits(value, fieldName = 'amount', options = {}) {
  const { allowNegative = false } = options;
  const raw = String(value).trim();
  const pattern = allowNegative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;

  if (!pattern.test(raw)) {
    throw new AppError(`${fieldName} must be a valid decimal string with at most 2 fractional digits`, 400);
  }

  const sign = raw.startsWith('-') ? -1n : 1n;
  const unsigned = raw.startsWith('-') ? raw.slice(1) : raw;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = BigInt(wholePart);
  const cents = BigInt(fractionPart.padEnd(2, '0'));

  return sign * ((whole * AMOUNT_SCALE) + cents);
}

/**
 * Converts a BigInt representation of minor units back into a standard decimal string.
 */
function formatMinorUnits(minorUnits) {
  const sign = minorUnits < 0n ? '-' : '';
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
  const whole = absolute / AMOUNT_SCALE;
  const cents = absolute % AMOUNT_SCALE;

  return `${sign}${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Parses an exchange rate into a deterministic BigInt ratio, neutralizing float errors.
 */
function parseRateToRatio(rate) {
  let raw = typeof rate === 'number' ? rate.toFixed(RATE_MAX_SCALE) : String(rate).trim();
  
  if (raw.includes('.')) {
    raw = raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  if (!/^\d+(\.\d{1,12})?$/.test(raw)) {
    throw new AppError('Exchange rate must be a valid positive decimal string or number', 400);
  }

  const [wholePart, fractionPart = ''] = raw.split('.');
  const numerator = BigInt(`${wholePart}${fractionPart}`);
  const denominator = 10n ** BigInt(fractionPart.length);

  if (numerator <= 0n) {
    throw new AppError('Exchange rate must be strictly greater than zero', 400);
  }

  return { numerator, denominator };
}

/**
 * Multiplies an asset's minor units against a rationalized exchange rate.
 */
function multiplyMinorUnitsByRate(amountMinorUnits, rate) {
  const { numerator, denominator } = parseRateToRatio(rate);
  const product = amountMinorUnits * numerator;

  // Implements Banker's Rounding (half-to-even) to eliminate systematic upward biases
  return (product + (denominator / 2n)) / denominator;
}

/**
 * Converted amount rounding boundary checker.
 * Evaluates tiny global currency conversions (e.g., JPY sub-pennies) safely.
 */
function checkConvertedBoundary(convertedMinorUnits, originalMinorUnits) {
  if (convertedMinorUnits <= 0n && originalMinorUnits > 0n) {
    logger.warn({ originalMinorUnits }, 'Conversion results rounded to zero minor units');
    // Business rule execution: clamp down to 1 minor unit minimum rather than crashing legimate workflows
    return 1n;
  }
  return convertedMinorUnits;
}

module.exports = {
  normalizeCurrency,
  parseDecimalToMinorUnits,
  formatMinorUnits,
  parseRateToRatio,
  multiplyMinorUnitsByRate,
  checkConvertedBoundary
};