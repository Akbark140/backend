// ── Security ─────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 12;

// ── Supported Currencies ─────────────────────────────────────────
const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'PKR',
  'AED',
  'SAR',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'INR',
  'BDT',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
];

// ── Default Categories ───────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  {
    name: 'Housing',
    icon: '🏠',
    color: '#6366f1',
    type: 'expense',
  },

  {
    name: 'Food',
    icon: '🍔',
    color: '#f59e0b',
    type: 'expense',
  },

  {
    name: 'Transport',
    icon: '🚗',
    color: '#3b82f6',
    type: 'expense',
  },

  {
    name: 'Utilities',
    icon: '⚡',
    color: '#8b5cf6',
    type: 'expense',
  },

  {
    name: 'Healthcare',
    icon: '🏥',
    color: '#ef4444',
    type: 'expense',
  },

  {
    name: 'Entertainment',
    icon: '🎬',
    color: '#ec4899',
    type: 'expense',
  },

  {
    name: 'Shopping',
    icon: '🛍️',
    color: '#f97316',
    type: 'expense',
  },

  {
    name: 'Education',
    icon: '📚',
    color: '#14b8a6',
    type: 'expense',
  },

  {
    name: 'Savings',
    icon: '💰',
    color: '#22c55e',
    type: 'expense',
  },

  {
    name: 'Salary',
    icon: '💼',
    color: '#10b981',
    type: 'income',
  },

  {
    name: 'Freelance',
    icon: '💻',
    color: '#06b6d4',
    type: 'income',
  },

  {
    name: 'Investments',
    icon: '📈',
    color: '#84cc16',
    type: 'income',
  },
];

// ── Budget Alert Thresholds ──────────────────────────────────────
const ALERT_THRESHOLDS = [
  0.8, // 80%
  1.0, // 100%
];

// ── Pagination Defaults ──────────────────────────────────────────
const PAGINATION_DEFAULTS = {
  page: 1,
  limit: 20,
  maxLimit: 100,
};

// ── Exports ──────────────────────────────────────────────────────
module.exports = {
  BCRYPT_ROUNDS,
  SUPPORTED_CURRENCIES,
  DEFAULT_CATEGORIES,
  ALERT_THRESHOLDS,
  PAGINATION_DEFAULTS,
};