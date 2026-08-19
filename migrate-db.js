const { pool } = require('./src/config/db.config');

async function migrate() {
  try {
    console.log('Starting schema migration...');

    // Ensure pgcrypto extension for gen_random_uuid()
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    `);
    console.log('✓ Ensured pgcrypto extension');

    // 1. Add avatar_url to oauth_accounts
    await pool.query(`
      ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    `);
    console.log('✓ Checked oauth_accounts.avatar_url');

    // 2. Add deleted_at to budgets
    await pool.query(`
      ALTER TABLE budgets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
    `);
    console.log('✓ Checked budgets.deleted_at');

    // 3. Add columns to transactions
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD';
    `);
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount_in_base_currency NUMERIC(12, 2);
    `);
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE;
    `);
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
    `);
    console.log('✓ Checked transactions columns (currency, amount_in_base_currency, is_recurring, deleted_at)');

    // 4. Update existing transactions where amount_in_base_currency is null
    await pool.query(`
      UPDATE transactions SET amount_in_base_currency = amount WHERE amount_in_base_currency IS NULL;
    `);
    console.log('✓ Backfilled amount_in_base_currency in transactions');

    // 5. Create ai_insights table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_insights (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type VARCHAR(50) NOT NULL CHECK (type IN ('recommendation', 'forecast')),
          target_month INTEGER NOT NULL CHECK (target_month >= 1 AND target_month <= 12),
          target_year INTEGER NOT NULL CHECK (target_year >= 2000),
          insight_text TEXT NOT NULL,
          recommended_budget JSONB,
          confidence_score NUMERIC(5,2),
          is_applied BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✓ Checked ai_insights table');

    console.log('✅ Database schema migration completed successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err);
  } finally {
    await pool.end();
  }
}

migrate();
