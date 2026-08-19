-- =========================================================
-- PRODUCTION-LEVEL POSTGRESQL SCHEMA
-- Finance Management System
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================
-- ENUMS
-- =========================================================

CREATE TYPE category_type AS ENUM ('income', 'expense');

CREATE TYPE transaction_type AS ENUM ('income', 'expense');

-- =========================================================
-- USERS
-- =========================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    email VARCHAR(255) NOT NULL UNIQUE,

    password_hash TEXT NOT NULL,

    name VARCHAR(255) NOT NULL,

    currency VARCHAR(10) NOT NULL DEFAULT 'USD',

    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',

    email_verified BOOLEAN DEFAULT FALSE,

    is_active BOOLEAN DEFAULT TRUE,

    last_login TIMESTAMP,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================
-- USERS INDEXES
-- =========================

CREATE INDEX idx_users_email
ON users(email);

CREATE INDEX idx_users_created_at
ON users(created_at);

-- =========================================================
-- CATEGORIES
-- =========================================================

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL,

    name VARCHAR(100) NOT NULL,

    icon VARCHAR(100),

    color VARCHAR(20),

    type category_type NOT NULL,

    is_default BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP DEFAULT NOW(),

    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT fk_categories_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

-- =========================
-- CATEGORY INDEXES
-- =========================

CREATE INDEX idx_categories_user_id
ON categories(user_id);

CREATE INDEX idx_categories_type
ON categories(type);

CREATE INDEX idx_categories_user_type
ON categories(user_id, type);

CREATE UNIQUE INDEX idx_categories_unique_name
ON categories(user_id, name, type);

-- =========================================================
-- BUDGETS
-- =========================================================

CREATE TABLE budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL,

    category_id UUID NOT NULL,

    month INTEGER NOT NULL
        CHECK (month >= 1 AND month <= 12),

    year INTEGER NOT NULL
        CHECK (year >= 2000),

    amount_limit NUMERIC(12,2) NOT NULL
        CHECK (amount_limit > 0),

    spent_amount NUMERIC(12,2) DEFAULT 0,

    created_at TIMESTAMP DEFAULT NOW(),

    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT fk_budgets_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_budgets_category
        FOREIGN KEY(category_id)
        REFERENCES categories(id)
        ON DELETE CASCADE
);

-- =========================
-- BUDGET INDEXES
-- =========================

CREATE INDEX idx_budgets_user_id
ON budgets(user_id);

CREATE INDEX idx_budgets_category_id
ON budgets(category_id);

CREATE INDEX idx_budgets_month_year
ON budgets(month, year);

CREATE UNIQUE INDEX idx_budgets_unique
ON budgets(user_id, category_id, month, year);

-- =========================================================
-- TRANSACTIONS
-- =========================================================

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL,

    category_id UUID NOT NULL,

    amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

    type transaction_type NOT NULL,

    description TEXT,

    date TIMESTAMP NOT NULL,

    receipt_url TEXT,

    notes TEXT,

    location VARCHAR(255),

    is_recurring BOOLEAN DEFAULT FALSE,

    recurring_interval VARCHAR(50),

    created_at TIMESTAMP DEFAULT NOW(),

    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT fk_transactions_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_transactions_category
        FOREIGN KEY(category_id)
        REFERENCES categories(id)
        ON DELETE CASCADE
);

-- =========================
-- TRANSACTION INDEXES
-- =========================

CREATE INDEX idx_transactions_user_id
ON transactions(user_id);

CREATE INDEX idx_transactions_category_id
ON transactions(category_id);

CREATE INDEX idx_transactions_date
ON transactions(date DESC);

CREATE INDEX idx_transactions_type
ON transactions(type);

CREATE INDEX idx_transactions_user_date
ON transactions(user_id, date DESC);

CREATE INDEX idx_transactions_user_category
ON transactions(user_id, category_id);

CREATE INDEX idx_transactions_amount
ON transactions(amount);

-- Full-text search index
CREATE INDEX idx_transactions_description_search
ON transactions
USING GIN(to_tsvector('english', description));

-- =========================================================
-- REFRESH TOKENS
-- =========================================================

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL,

    token_hash TEXT NOT NULL,

    user_agent TEXT,

    ip_address VARCHAR(100),

    expires_at TIMESTAMP NOT NULL,

    revoked_at TIMESTAMP,

    created_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT fk_refresh_tokens_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

-- =========================
-- REFRESH TOKEN INDEXES
-- =========================

CREATE INDEX idx_refresh_tokens_user_id
ON refresh_tokens(user_id);

CREATE INDEX idx_refresh_tokens_expires_at
ON refresh_tokens(expires_at);

CREATE INDEX idx_refresh_tokens_revoked_at
ON refresh_tokens(revoked_at);

-- =========================================================
-- UPDATED_AT AUTO UPDATE FUNCTION
-- =========================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

-- =========================================================
-- TRIGGERS
-- =========================================================

CREATE TRIGGER trigger_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_categories_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_budgets_updated_at
BEFORE UPDATE ON budgets
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_transactions_updated_at
BEFORE UPDATE ON transactions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- =========================================================
-- USEFUL VIEWS
-- =========================================================

-- Monthly expense summary
CREATE VIEW monthly_expense_summary AS
SELECT
    user_id,
    DATE_TRUNC('month', date) AS month,
    SUM(amount) AS total_expense
FROM transactions
WHERE type = 'expense'
GROUP BY user_id, DATE_TRUNC('month', date);

-- Monthly income summary
CREATE VIEW monthly_income_summary AS
SELECT
    user_id,
    DATE_TRUNC('month', date) AS month,
    SUM(amount) AS total_income
FROM transactions
WHERE type = 'income'
GROUP BY user_id, DATE_TRUNC('month', date);

-- =========================================================
-- PERFORMANCE ANALYSIS
-- =========================================================

ANALYZE;