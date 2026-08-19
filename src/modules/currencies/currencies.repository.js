const db = require('../../config/db.config'); // Your pg/pool connection

async function getCachedRate(fromCurrency, toCurrency) {
  const query = `
    SELECT rate, updated_at 
    FROM exchange_rates 
    WHERE from_currency = $1 AND to_currency = $2;
  `;
  const { rows } = await db.query(query, [fromCurrency.toUpperCase(), toCurrency.toUpperCase()]);
  return rows[0] || null;
}

async function upsertRate(fromCurrency, toCurrency, rate) {
  const query = `
    INSERT INTO exchange_rates (from_currency, to_currency, rate, updated_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (from_currency, to_currency)
    DO UPDATE SET rate = EXCLUDED.rate, updated_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;
  const { rows } = await db.query(query, [fromCurrency.toUpperCase(), toCurrency.toUpperCase(), rate]);
  return rows[0];
}

module.exports = {
  getCachedRate,
  upsertRate
};