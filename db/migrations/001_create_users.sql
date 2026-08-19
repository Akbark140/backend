-- =========================================================
-- USERS TABLE MIGRATION (WEALTHFLUX)
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================
-- USERS TABLE
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT,  -- nullable for OAuth users

    role VARCHAR(50) DEFAULT 'user',

    avatar_url TEXT,

    currency VARCHAR(10) DEFAULT 'USD',

    timezone VARCHAR(100) DEFAULT 'UTC',

    balance NUMERIC(14,2) DEFAULT 0,

    is_active BOOLEAN DEFAULT TRUE,

    is_verified BOOLEAN DEFAULT FALSE,

    last_login_at TIMESTAMPTZ,

    -- Verification system
    verification_token TEXT,
    verification_token_expires_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    deleted_at TIMESTAMPTZ
);

-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_users_email
ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_created_at
ON users(created_at);

CREATE INDEX IF NOT EXISTS idx_users_role
ON users(role);

CREATE INDEX IF NOT EXISTS idx_users_active
ON users(is_active);

-- =========================================================
-- AUTO UPDATE TIMESTAMP FUNCTION
-- =========================================================

CREATE OR REPLACE FUNCTION update_updated_at_users()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =========================================================
-- TRIGGER
-- =========================================================

DROP TRIGGER IF EXISTS trigger_users_updated_at ON users;

CREATE TRIGGER trigger_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_users();

-- =========================================================
-- OPTIONAL: SAFETY CONSTRAINTS
-- =========================================================

-- Ensure balance never goes NULL
ALTER TABLE users
ALTER COLUMN balance SET DEFAULT 0;

-- Ensure email format uniqueness already enforced by UNIQUE
-- =========================================================

-- DONE