// notification.repository.js
const assert = require('assert').strict;
const { query } = require('../../config/db.config');

// ── Custom Type Assertion Polyfills for Node.js Native Assert Module ──
assert.string = (val, message) => {
    assert.ok(typeof val === 'string', message || `Expected string, received ${typeof val}`);
};

assert.number = (val, message) => {
    assert.ok(typeof val === 'number' && !isNaN(val), message || `Expected number, received ${typeof val}`);
};

assert.boolean = (val, message) => {
    assert.ok(typeof val === 'boolean', message || `Expected boolean, received ${typeof val}`);
};

// ── Data Record Mappers ──────────────────────────────────────────
/**
 * Maps raw database rows into predictable system-wide JSON schemas.
 */
const mapPreferenceRow = (row) => {
    if (!row) return null;
    return Object.freeze({
        type: String(row.type),
        enabled: Boolean(row.enabled),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    });
};

const mapHistoryRow = (row) => {
    if (!row) return null;
    return Object.freeze({
        id: String(row.id),
        type: String(row.type),
        title: String(row.title),
        body: String(row.body),
        url: row.url ? String(row.url) : null,
        status: String(row.status),
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    });
};

// ── Repository Implementations ────────────────────────────────────

/**
 * Persist a physical tracking entry trace for historical audit logging interfaces.
 */
const logNotification = async ({ userId, type, title, body, url, status }) => {
    assert.string(type, 'Repository Error: Invalid notification type property specification.');
    assert.string(title, 'Repository Error: Missing tracking title string spec.');
    assert.string(status, 'Repository Error: Missing execution status checkpoint value.');

    const sql = {
        name: 'notification-history-insert',
        text: `INSERT INTO notification_history (user_id, type, title, body, url, status, sent_at)
               VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, NOW())`,
        values: [userId || null, type, title, body, url || null, status],
    };

    await query(sql);
};

/**
 * Check if the target user profile has a specific notification flag configuration active.
 */
const getUserPreferenceRow = async (userId, type) => {
    assert.ok(userId, 'Repository Requirement: userId context is required for lookup profiles.');
    assert.string(type, 'Repository Requirement: Preference key type categorization is mandatory.');

    const sql = {
        name: 'get-notification-preference',
        text: `SELECT enabled FROM notification_preferences 
               WHERE user_id = $1::uuid AND type = $2::text
               LIMIT 1`,
        values: [userId, type],
    };

    const result = await query(sql);
    return result.rows[0] ? { enabled: Boolean(result.rows[0].enabled) } : null;
};

/**
 * Upsert dynamic custom preferences maps linked to unique entity constraints keys.
 */
const upsertUserPreference = async (userId, type, enabled) => {
    assert.ok(userId, 'Repository Requirement: Execution requires valid target profile ID.');
    assert.string(type, 'Repository Requirement: Structural target key type is required.');
    assert.boolean(enabled, 'Repository Requirement: Switch state mutation requires explicit boolean.');

    const sql = {
        name: 'upsert-user-preference',
        text: `INSERT INTO notification_preferences (user_id, type, enabled)
               VALUES ($1::uuid, $2::text, $3::boolean)
               ON CONFLICT (user_id, type)
               DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
               RETURNING type, enabled, updated_at`,
        values: [userId, type, enabled],
    };

    const result = await query(sql);
    return mapPreferenceRow(result.rows[0]);
};

/**
 * Extract active application constraints mappings registered for specific profiles.
 */
const getUserPreferencesList = async (userId) => {
    assert.ok(userId, 'Repository Requirement: Invalid parameters passed to lookup utility.');

    const sql = {
        name: 'list-user-preferences',
        text: `SELECT type, enabled, updated_at FROM notification_preferences 
               WHERE user_id = $1::uuid 
               ORDER BY type ASC`,
        values: [userId],
    };

    const result = await query(sql);
    return Object.freeze(result.rows.map(mapPreferenceRow));
};

/**
 * Collect tracking identifiers matching active instances registered under profiles.
 */
const getSubscriptionsByUserId = async (userId) => {
    assert.ok(userId, 'Repository Requirement: Identification parameter context required.');

    const sql = {
        name: 'get-user-push-subscriptions',
        text: `SELECT endpoint, p256dh, auth FROM push_subscriptions 
               WHERE user_id = $1::uuid`,
        values: [userId],
    };

    const result = await query(sql);
    return Object.freeze(result.rows);
};

/**
 * Scans total system tables mapping registered push messaging endpoints profiles.
 */
const getAllSubscriptions = async () => {
    const sql = {
        name: 'get-all-push-subscriptions',
        text: `SELECT endpoint, p256dh, auth FROM push_subscriptions`,
    };

    const result = await query(sql);
    return Object.freeze(result.rows);
};

/**
 * Register fresh access vectors tracking physical client interfaces tokens.
 */
const upsertSubscription = async (userId, endpoint, p256dh, auth) => {
    assert.string(endpoint, 'Repository Specification: Physical hardware endpoint destination string required.');
    assert.string(p256dh, 'Repository Specification: Public key vector is mandatory.');
    assert.string(auth, 'Repository Specification: Cryptographic authentication token parameter required.');

    const sql = {
        name: 'upsert-push-subscription',
        text: `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
               VALUES ($1::uuid, $2::text, $3::text, $4::text)
               ON CONFLICT (endpoint)
               DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
                             auth = EXCLUDED.auth, updated_at = NOW()
               RETURNING endpoint, p256dh, auth`,
        values: [userId || null, endpoint, p256dh, auth],
    };

    const result = await query(sql);
    return result.rows[0];
};

/**
 * Expel non-routable communication channels permanently out of data processing chains.
 */
const deleteSubscriptionByEndpoint = async (endpoint) => {
    assert.string(endpoint, 'Repository Specification: String manipulation requirements unmatched.');

    const sql = {
        name: 'delete-push-subscription',
        text: `DELETE FROM push_subscriptions 
               WHERE endpoint = $1::text 
               RETURNING endpoint`,
        values: [endpoint],
    };

    const result = await query(sql);
    return result.rows[0] || null;
};

/**
 * Pagination collection utility reading chronological database records tracks safely.
 */
const getHistoryList = async (userId, limit, offset) => {
    assert.ok(userId, 'Specification Boundary violation: missing identifier verification contextual state.');
    assert.number(limit, 'Specification Bound requirement: numeric sizing definition missing.');
    assert.number(offset, 'Specification Bound requirement: numeric indices mapping missing.');

    const sql = {
        name: 'get-notification-history-page',
        text: `SELECT id, type, title, body, url, status, sent_at
               FROM notification_history
               WHERE user_id = $1::uuid
               ORDER BY sent_at DESC
               LIMIT $2::integer OFFSET $3::integer`,
        values: [userId, limit, offset],
    };

    const result = await query(sql);
    return Object.freeze(result.rows.map(mapHistoryRow));
};

/**
 * Count total historical log tracing records registered across tables metrics indexes.
 */
const getHistoryCount = async (userId) => {
    assert.ok(userId, 'Specification Boundary Requirement: verification tracking ID context missing.');

    const sql = {
        name: 'get-notification-history-count',
        text: `SELECT COUNT(*)::integer as total FROM notification_history 
               WHERE user_id = $1::uuid`,
        values: [userId],
    };

    const result = await query(sql);
    return parseInt(result.rows[0]?.total || 0, 10);
};

/**
 * Read current processing month cap threshold parameters.
 */
const getBudgetDetails = async (userId, categoryId, yearMonth) => {
    assert.ok(userId);
    assert.ok(categoryId);
    assert.string(yearMonth, 'Specification Constraint: Validation match requires parameter string "YYYY-MM".');

    const sql = {
        name: 'get-budget-alert-details',
        text: `SELECT b.amount::numeric, b.alert_sent_at, c.name::text as category_name
               FROM budgets b
               JOIN categories c ON c.id = b.category_id
               WHERE b.user_id = $1::uuid 
                 AND b.category_id = $2::integer
                 AND b.month = $3::text
               LIMIT 1`,
        values: [userId, categoryId, yearMonth],
    };

    const result = await query(sql);
    return result.rows[0] || null;
};

/**
 * Aggregates runtime execution data metrics representing operational deltas.
 */
const getSpentAmountForCategory = async (userId, categoryId, dateWildcard) => {
    assert.string(dateWildcard, 'Specification Requirement: Pattern validation string wildcards matching parameter input required.');

    const sql = {
        name: 'calculate-category-monthly-spent',
        text: `SELECT COALESCE(SUM(amount_in_base), 0)::numeric as total_spent
               FROM transactions
               WHERE user_id = $1::uuid
                 AND category_id = $2::integer
                 AND type = 'expense'
                 AND date LIKE $3::text`,
        values: [userId, categoryId, dateWildcard],
    };

    const result = await query(sql);
    return parseFloat(result.rows[0]?.total_spent || 0);
};

/**
 * Block duplicate outputs processing checks patterns across chronological scopes.
 */
const updateBudgetAlertTimestamp = async (userId, categoryId, yearMonth) => {
    const sql = {
        name: 'update-budget-alert-timestamp',
        text: `UPDATE budgets SET alert_sent_at = NOW()
               WHERE user_id = $1::uuid 
                 AND category_id = $2::integer 
                 AND month = $3::text`,
        values: [userId, categoryId, yearMonth],
    };

    await query(sql);
};

module.exports = {
    logNotification,
    getUserPreferenceRow,
    upsertUserPreference,
    getUserPreferencesList,
    getSubscriptionsByUserId,
    getAllSubscriptions,
    upsertSubscription,
    deleteSubscriptionByEndpoint,
    getHistoryList,
    getHistoryCount,
    getBudgetDetails,
    getSpentAmountForCategory,
    updateBudgetAlertTimestamp,
};