const { query, withTransaction, closePool } = require('./src/config/db.config');
const { logger } = require('./src/config/logger.config');

async function migrate() {
  try {
    logger.info('Starting schema migration...');

    // Execute schema changes in a single atomic transaction
    await withTransaction(async (tx) => {
      // 1. Ensure pgcrypto extension for gen_random_uuid()
      await tx.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
      logger.info('✓ Ensured pgcrypto extension');

      // 2. Add avatar_url to oauth_accounts
      await tx.query(`
        ALTER TABLE oauth_accounts 
        ADD COLUMN IF NOT EXISTS avatar_url TEXT;
      `);
      logger.info('✓ Checked oauth_accounts.avatar_url');

      // 3. Add deleted_at to budgets
      await tx.query(`
        ALTER TABLE budgets 
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
      `);
      logger.info('✓ Checked budgets.deleted_at');

      // 4. Add columns to transactions
      await tx.query(`
        ALTER TABLE transactions 
        ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD',
        ADD COLUMN IF NOT EXISTS amount_in_base_currency NUMERIC(12, 2),
        ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
      `);
      logger.info('✓ Checked transactions columns (currency, amount_in_base_currency, is_recurring, deleted_at)');

      // 5. Backfill existing transactions where amount_in_base_currency is null
      await tx.query(`
        UPDATE transactions 
        SET amount_in_base_currency = amount 
        WHERE amount_in_base_currency IS NULL;
      `);
      logger.info('✓ Backfilled amount_in_base_currency in transactions');

      // 6. Create ai_insights table
      await tx.query(`
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
      logger.info('✓ Checked ai_insights table');
    });

    logger.info('✅ Database schema migration completed successfully.');
  } catch (err) {
    logger.error({ err }, '❌ Migration failed');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

migrate();