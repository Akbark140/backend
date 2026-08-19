/**
 * @file ledgerEngine.js
 * @module LedgerEngine
 * @version 2.0.0
 *
 * Enterprise-grade Double-Entry Bookkeeping Engine
 *
 * Architectural Philosophy:
 * ─────────────────────────
 * This engine is designed around the immutable ledger principle used in
 * banking-grade accounting systems (e.g., Temenos T24, SAP FICO, Oracle Financials).
 *
 * Core Invariant: For EVERY transaction posted to the ledger:
 *   ΣDebits = ΣCredits
 *
 * This invariant is enforced at the domain layer BEFORE any I/O occurs,
 * making it impossible to post an unbalanced entry regardless of caller.
 *
 * Design Patterns Used:
 *   - Domain-Driven Design (DDD): Rich domain models, Value Objects, Aggregates
 *   - Repository Pattern: Decouple domain logic from persistence
 *   - Unit of Work: Atomic cross-aggregate commits
 *   - CQRS-ready: Read models (statements, trial balance) separated from write models
 *   - Event Sourcing-compatible: Every mutation emits a domain event
 *   - Service Layer: Application services orchestrate domain without leaking infra
 *
 * @author  FinTech Engineering Team
 * @license MIT
 */

'use strict';

const { EventEmitter } = require('events');
const { v4: uuidv4 }  = require('uuid');
const Decimal          = require('decimal.js');

// ─────────────────────────────────────────────────────────────────────────────
// PRECISION CONFIGURATION
// Decimal.js is used throughout because IEEE 754 floating-point is UNACCEPTABLE
// for financial arithmetic. 0.1 + 0.2 !== 0.3 in native JS.
// We set 20 significant digits to safely handle amounts up to 1 quadrillion
// with cent-level precision.
// ─────────────────────────────────────────────────────────────────────────────
Decimal.set({
  precision:   20,
  rounding:    Decimal.ROUND_HALF_EVEN,   // "Banker's rounding" — statistically unbiased
  toExpPos:    20,
  toExpNeg:   -20,
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & ENUMERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Account normal balance sides per the accounting equation:
 *   Assets + Expenses = Liabilities + Equity + Revenue
 *
 * The "normal balance" side is the side that INCREASES the account.
 * A Debit increases an Asset; a Credit increases a Liability.
 * This drives validation in JournalValidator.
 */
const AccountType = Object.freeze({
  ASSET:     'ASSET',
  LIABILITY: 'LIABILITY',
  EQUITY:    'EQUITY',
  REVENUE:   'REVENUE',
  EXPENSE:   'EXPENSE',
});

/**
 * Normal balance side by account type.
 * Debit-normal: ASSET, EXPENSE
 * Credit-normal: LIABILITY, EQUITY, REVENUE
 */
const NormalBalance = Object.freeze({
  [AccountType.ASSET]:     'DEBIT',
  [AccountType.LIABILITY]: 'CREDIT',
  [AccountType.EQUITY]:    'CREDIT',
  [AccountType.REVENUE]:   'CREDIT',
  [AccountType.EXPENSE]:   'DEBIT',
});

const EntryType = Object.freeze({
  DEBIT:  'DEBIT',
  CREDIT: 'CREDIT',
});

const TransactionStatus = Object.freeze({
  PENDING:   'PENDING',
  POSTED:    'POSTED',
  REVERSED:  'REVERSED',
  VOIDED:    'VOIDED',
});

const LedgerEvent = Object.freeze({
  TRANSACTION_POSTED:   'transaction:posted',
  TRANSACTION_REVERSED: 'transaction:reversed',
  ACCOUNT_CREATED:      'account:created',
  PERIOD_CLOSED:        'period:closed',
  LEDGER_FROZEN:        'ledger:frozen',
  BALANCE_SNAPSHOT:     'balance:snapshot',
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM FINANCIAL EXCEPTIONS
// Typed exceptions allow upstream error handlers and monitoring systems
// (e.g., Sentry, DataDog) to classify financial errors precisely.
// ─────────────────────────────────────────────────────────────────────────────

class LedgerError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name    = 'LedgerError';
    this.code    = code;
    this.context = context;
    // Capture stack without polluting V8 optimization
    if (Error.captureStackTrace) Error.captureStackTrace(this, LedgerError);
  }
}

class ImbalancedEntryError extends LedgerError {
  constructor(debitTotal, creditTotal) {
    super(
      `Journal entry is imbalanced: Debits=${debitTotal} Credits=${creditTotal}`,
      'ERR_IMBALANCED_ENTRY',
      { debitTotal, creditTotal }
    );
    this.name = 'ImbalancedEntryError';
  }
}

class AccountNotFoundError extends LedgerError {
  constructor(accountId) {
    super(`Account not found: ${accountId}`, 'ERR_ACCOUNT_NOT_FOUND', { accountId });
    this.name = 'AccountNotFoundError';
  }
}

class DuplicateTransactionError extends LedgerError {
  constructor(idempotencyKey) {
    super(
      `Transaction already posted with idempotency key: ${idempotencyKey}`,
      'ERR_DUPLICATE_TRANSACTION',
      { idempotencyKey }
    );
    this.name = 'DuplicateTransactionError';
  }
}

class FrozenLedgerError extends LedgerError {
  constructor(reason) {
    super(`Ledger is frozen and cannot accept new postings: ${reason}`, 'ERR_LEDGER_FROZEN', { reason });
    this.name = 'FrozenLedgerError';
  }
}

class ClosedPeriodError extends LedgerError {
  constructor(period) {
    super(`Fiscal period is closed: ${period}`, 'ERR_CLOSED_PERIOD', { period });
    this.name = 'ClosedPeriodError';
  }
}

class InvalidReversalError extends LedgerError {
  constructor(transactionId, reason) {
    super(`Cannot reverse transaction ${transactionId}: ${reason}`, 'ERR_INVALID_REVERSAL', { transactionId, reason });
    this.name = 'InvalidReversalError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE OBJECTS
// Immutable objects identified by their value, not identity.
// Money and AccountCode are the key value objects in accounting domain.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Money — immutable, precision-safe monetary value with currency.
 * All arithmetic returns a new Money instance (immutability).
 */
class Money {
  #amount;
  #currency;

  constructor(amount, currency = 'USD') {
    if (typeof currency !== 'string' || currency.length !== 3) {
      throw new LedgerError(`Invalid currency code: ${currency}`, 'ERR_INVALID_CURRENCY');
    }
    this.#amount   = new Decimal(amount);
    this.#currency = currency.toUpperCase();
    Object.freeze(this);
  }

  get amount()   { return this.#amount; }
  get currency() { return this.#currency; }

  add(other) {
    this.#assertSameCurrency(other);
    return new Money(this.#amount.plus(other.amount), this.#currency);
  }

  subtract(other) {
    this.#assertSameCurrency(other);
    return new Money(this.#amount.minus(other.amount), this.#currency);
  }

  equals(other) {
    return this.#currency === other.currency && this.#amount.equals(other.amount);
  }

  isZero()     { return this.#amount.isZero(); }
  isPositive() { return this.#amount.isPositive() && !this.#amount.isZero(); }
  isNegative() { return this.#amount.isNegative(); }

  /**
   * Negate — used when reversing entries (flip debit ↔ credit).
   */
  negate() {
    return new Money(this.#amount.negated(), this.#currency);
  }

  toDecimalString() { return this.#amount.toFixed(2); }
  toJSON() {
    return { amount: this.toDecimalString(), currency: this.#currency };
  }

  #assertSameCurrency(other) {
    if (this.#currency !== other.currency) {
      throw new LedgerError(
        `Currency mismatch: ${this.#currency} vs ${other.currency}`,
        'ERR_CURRENCY_MISMATCH'
      );
    }
  }

  static ZERO(currency = 'USD') { return new Money(0, currency); }
}

/**
 * AccountCode — structured account numbering (e.g., "1000", "1001.01").
 * Encapsulates format validation so invalid codes cannot exist in the domain.
 */
class AccountCode {
  #code;

  constructor(code) {
    const str = String(code).trim();
    if (!/^\d{4}(\.\d{1,4})?$/.test(str)) {
      throw new LedgerError(
        `Invalid account code format: "${str}". Expected XXXX or XXXX.XX`,
        'ERR_INVALID_ACCOUNT_CODE'
      );
    }
    this.#code = str;
    Object.freeze(this);
  }

  get value() { return this.#code; }
  toString()  { return this.#code; }
  equals(other) { return this.#code === other.value; }

  /**
   * Parse the high-level category from account code.
   * Standard COA ranges: 1xxx=Asset, 2xxx=Liability, 3xxx=Equity, 4xxx=Revenue, 5xxx=Expense
   */
  get category() {
    const prefix = parseInt(this.#code.charAt(0), 10);
    switch (prefix) {
      case 1: return AccountType.ASSET;
      case 2: return AccountType.LIABILITY;
      case 3: return AccountType.EQUITY;
      case 4: return AccountType.REVENUE;
      case 5: return AccountType.EXPENSE;
      default: return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN ENTITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LedgerAccount — Aggregate Root for account state.
 *
 * Owns the running balance and enforces account-level invariants.
 * Balance is NOT stored as a mutable field — it is always derived
 * from the posted entries to guarantee consistency (see getBalance).
 *
 * For performance at scale, the repository layer may cache the
 * running balance using a Redis sorted set keyed by account + timestamp.
 */
class LedgerAccount {
  #id;
  #code;
  #name;
  #type;
  #currency;
  #isActive;
  #isSuspense;         // Suspense accounts catch temporarily unclassified amounts
  #metadata;
  #createdAt;

  constructor({ id, code, name, type, currency = 'USD', isSuspense = false, metadata = {} }) {
    if (!Object.values(AccountType).includes(type)) {
      throw new LedgerError(`Invalid account type: ${type}`, 'ERR_INVALID_ACCOUNT_TYPE');
    }
    this.#id        = id || uuidv4();
    this.#code      = new AccountCode(code);
    this.#name      = name;
    this.#type      = type;
    this.#currency  = currency;
    this.#isActive  = true;
    this.#isSuspense = isSuspense;
    this.#metadata  = Object.freeze({ ...metadata });
    this.#createdAt = new Date();
  }

  get id()         { return this.#id; }
  get code()       { return this.#code.value; }
  get name()       { return this.#name; }
  get type()       { return this.#type; }
  get currency()   { return this.#currency; }
  get isActive()   { return this.#isActive; }
  get isSuspense() { return this.#isSuspense; }
  get metadata()   { return this.#metadata; }
  get createdAt()  { return this.#createdAt; }
  get normalBalance() { return NormalBalance[this.#type]; }

  deactivate() { this.#isActive = false; }
  activate()   { this.#isActive = true; }

  toJSON() {
    return {
      id:        this.#id,
      code:      this.#code.value,
      name:      this.#name,
      type:      this.#type,
      currency:  this.#currency,
      isActive:  this.#isActive,
      isSuspense: this.#isSuspense,
      metadata:  this.#metadata,
      createdAt: this.#createdAt.toISOString(),
    };
  }
}

/**
 * JournalEntry — immutable record of a single debit or credit line.
 *
 * WHY IMMUTABLE: Once posted, a ledger line must never change.
 * Corrections are made via REVERSAL transactions (new offsetting entries),
 * preserving the complete audit trail. This matches GAAP/IFRS requirements
 * and SOX audit controls.
 */
class JournalEntry {
  constructor({ id, transactionId, accountId, entryType, money, description, sequence }) {
    if (!Object.values(EntryType).includes(entryType)) {
      throw new LedgerError(`Invalid entry type: ${entryType}`, 'ERR_INVALID_ENTRY_TYPE');
    }
    if (!(money instanceof Money) || !money.isPositive()) {
      throw new LedgerError('Entry amount must be a positive Money instance', 'ERR_INVALID_AMOUNT');
    }

    this.id            = id || uuidv4();
    this.transactionId = transactionId;
    this.accountId     = accountId;
    this.entryType     = entryType;      // DEBIT or CREDIT
    this.money         = money;
    this.description   = description;
    this.sequence      = sequence;       // Line order within the transaction
    this.postedAt      = new Date();

    Object.freeze(this);
  }

  get isDebit()  { return this.entryType === EntryType.DEBIT; }
  get isCredit() { return this.entryType === EntryType.CREDIT; }

  toJSON() {
    return {
      id:            this.id,
      transactionId: this.transactionId,
      accountId:     this.accountId,
      entryType:     this.entryType,
      amount:        this.money.toDecimalString(),
      currency:      this.money.currency,
      description:   this.description,
      sequence:      this.sequence,
      postedAt:      this.postedAt.toISOString(),
    };
  }
}

/**
 * Transaction — the Aggregate Root for a double-entry accounting event.
 *
 * A transaction groups 2..N JournalEntries that together form a balanced
 * accounting event (ΣDebits = ΣCredits).
 *
 * Examples:
 *   Simple (2 lines)  — Cash received for services: DR Cash / CR Revenue
 *   Complex (N lines) — Payroll: DR Salaries Expense / CR Taxes Payable / CR Cash
 */
class Transaction {
  #id;
  #idempotencyKey;
  #reference;
  #description;
  #entries;
  #status;
  #reversalOfId;       // ID of original transaction if this is a reversal
  #reversedById;       // ID of reversal transaction
  #fiscalPeriod;
  #metadata;
  #version;            // Optimistic concurrency control
  #createdAt;
  #postedAt;

  constructor({
    id,
    idempotencyKey,
    reference,
    description,
    entries,
    fiscalPeriod,
    metadata = {},
    reversalOfId = null,
  }) {
    this.#id             = id || uuidv4();
    this.#idempotencyKey = idempotencyKey || this.#id;
    this.#reference      = reference;
    this.#description    = description;
    this.#entries        = [];
    this.#status         = TransactionStatus.PENDING;
    this.#reversalOfId   = reversalOfId;
    this.#reversedById   = null;
    this.#fiscalPeriod   = fiscalPeriod || FiscalPeriod.current();
    this.#metadata       = Object.freeze({ ...metadata });
    this.#version        = 1;
    this.#createdAt      = new Date();
    this.#postedAt       = null;

    if (entries && entries.length) this.#attachEntries(entries);
  }

  get id()             { return this.#id; }
  get idempotencyKey() { return this.#idempotencyKey; }
  get reference()      { return this.#reference; }
  get description()    { return this.#description; }
  get entries()        { return [...this.#entries]; }   // defensive copy
  get status()         { return this.#status; }
  get reversalOfId()   { return this.#reversalOfId; }
  get reversedById()   { return this.#reversedById; }
  get fiscalPeriod()   { return this.#fiscalPeriod; }
  get metadata()       { return this.#metadata; }
  get version()        { return this.#version; }
  get createdAt()      { return this.#createdAt; }
  get postedAt()       { return this.#postedAt; }
  get isPosted()       { return this.#status === TransactionStatus.POSTED; }
  get isReversed()     { return this.#status === TransactionStatus.REVERSED; }

  /**
   * Compute debit total across all entries.
   * We reduce over Decimal to maintain precision chain — no intermediate floats.
   */
  get debitTotal() {
    return this.#entries
      .filter(e => e.isDebit)
      .reduce((sum, e) => sum.add(e.money), Money.ZERO(this.#getCurrency()));
  }

  get creditTotal() {
    return this.#entries
      .filter(e => e.isCredit)
      .reduce((sum, e) => sum.add(e.money), Money.ZERO(this.#getCurrency()));
  }

  /**
   * Check the fundamental accounting invariant ΣDebits = ΣCredits.
   * This MUST pass before posting.
   */
  get isBalanced() {
    if (this.#entries.length < 2) return false;
    return this.debitTotal.equals(this.creditTotal);
  }

  markPosted() {
    this.#status   = TransactionStatus.POSTED;
    this.#postedAt = new Date();
    this.#version++;
  }

  markReversed(reversalTxnId) {
    this.#status      = TransactionStatus.REVERSED;
    this.#reversedById = reversalTxnId;
    this.#version++;
  }

  #attachEntries(rawEntries) {
    rawEntries.forEach((e, idx) => {
      this.#entries.push(new JournalEntry({
        transactionId: this.#id,
        accountId:     e.accountId,
        entryType:     e.entryType,
        money:         e.money instanceof Money ? e.money : new Money(e.amount, e.currency),
        description:   e.description || this.#description,
        sequence:      idx + 1,
      }));
    });
  }

  #getCurrency() {
    return this.#entries.length > 0 ? this.#entries[0].money.currency : 'USD';
  }

  toJSON() {
    return {
      id:             this.#id,
      idempotencyKey: this.#idempotencyKey,
      reference:      this.#reference,
      description:    this.#description,
      status:         this.#status,
      fiscalPeriod:   this.#fiscalPeriod,
      reversalOfId:   this.#reversalOfId,
      reversedById:   this.#reversedById,
      debitTotal:     this.debitTotal.toDecimalString(),
      creditTotal:    this.creditTotal.toDecimalString(),
      isBalanced:     this.isBalanced,
      version:        this.#version,
      createdAt:      this.#createdAt.toISOString(),
      postedAt:       this.#postedAt?.toISOString() || null,
      entries:        this.#entries.map(e => e.toJSON()),
      metadata:       this.#metadata,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FISCAL PERIOD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FiscalPeriod — represents an accounting period (month/year).
 * Closed periods reject new postings, preserving finalized financial statements.
 */
class FiscalPeriod {
  #year;
  #month;
  #isClosed;
  #closedAt;
  #closedBy;

  constructor(year, month) {
    if (month < 1 || month > 12) throw new LedgerError('Month must be 1-12', 'ERR_INVALID_PERIOD');
    this.#year    = year;
    this.#month   = month;
    this.#isClosed = false;
    this.#closedAt = null;
    this.#closedBy = null;
  }

  get year()     { return this.#year; }
  get month()    { return this.#month; }
  get isClosed() { return this.#isClosed; }
  get key()      { return `${this.#year}-${String(this.#month).padStart(2, '0')}`; }

  close(closedBy) {
    if (this.#isClosed) throw new LedgerError('Period already closed', 'ERR_PERIOD_ALREADY_CLOSED');
    this.#isClosed = true;
    this.#closedAt = new Date();
    this.#closedBy = closedBy;
  }

  assertOpen() {
    if (this.#isClosed) throw new ClosedPeriodError(this.key);
  }

  static current() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  toJSON() {
    return {
      year:     this.#year,
      month:    this.#month,
      key:      this.key,
      isClosed: this.#isClosed,
      closedAt: this.#closedAt?.toISOString() || null,
      closedBy: this.#closedBy,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
// SOX, PCI-DSS, and GAAP require immutable audit trails.
// Every state change writes an audit record that cannot be updated or deleted.
// In production this would write to an append-only table or immutable S3 log.
// ─────────────────────────────────────────────────────────────────────────────

class AuditLog {
  #entries = [];

  write({ action, entityType, entityId, actor, before, after, metadata = {} }) {
    const record = Object.freeze({
      id:         uuidv4(),
      timestamp:  new Date().toISOString(),
      action,          // 'POST_TRANSACTION', 'REVERSE_TRANSACTION', 'CLOSE_PERIOD', etc.
      entityType,      // 'Transaction', 'Account', 'FiscalPeriod'
      entityId,
      actor,           // User/service that triggered the action
      before,          // Snapshot before (null for creates)
      after,           // Snapshot after
      metadata,
    });
    this.#entries.push(record);
    // In production: await auditRepository.append(record);
    return record;
  }

  getHistory(entityId) {
    return this.#entries.filter(e => e.entityId === entityId);
  }

  getAll() { return [...this.#entries]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY REPOSITORIES
// These implement the Repository interface. Swap with a Postgres/Redis-backed
// implementation without changing any domain or application logic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AccountRepository — manages account persistence and lookup.
 *
 * Production implementation would use Postgres with:
 *   - B-tree index on account_code for O(log n) lookups
 *   - Partial index on is_active=true for active account queries
 *   - Row-level security for multi-tenant isolation
 */
class InMemoryAccountRepository {
  #store = new Map(); // accountId → LedgerAccount

  async save(account) {
    this.#store.set(account.id, account);
    return account;
  }

  async findById(id) {
    return this.#store.get(id) || null;
  }

  async findByCode(code) {
    for (const account of this.#store.values()) {
      if (account.code === String(code)) return account;
    }
    return null;
  }

  async findAll() {
    return [...this.#store.values()];
  }

  async findActive() {
    return [...this.#store.values()].filter(a => a.isActive);
  }
}

/**
 * TransactionRepository — manages transaction and entry persistence.
 *
 * Production implementation would use Postgres with:
 *   - Partitioned table on fiscal_period for efficient period queries
 *   - BRIN index on posted_at for time-range scans
 *   - Idempotency key unique index for duplicate detection
 *   - Entries stored in a child table with FK to transactions
 *   - Advisory locks for concurrent posting to same account
 */
class InMemoryTransactionRepository {
  #transactions  = new Map(); // txnId → Transaction
  #byIdempotency = new Map(); // idempotencyKey → txnId
  #entries       = [];        // flat list for cross-account queries

  async save(transaction) {
    this.#transactions.set(transaction.id, transaction);
    this.#byIdempotency.set(transaction.idempotencyKey, transaction.id);
    for (const entry of transaction.entries) this.#entries.push(entry);
    return transaction;
  }

  async findById(id) {
    return this.#transactions.get(id) || null;
  }

  async findByIdempotencyKey(key) {
    const id = this.#byIdempotency.get(key);
    return id ? this.#transactions.get(id) : null;
  }

  async findEntriesByAccountId(accountId, { fromDate, toDate, limit } = {}) {
    return this.#entries
      .filter(e => {
        if (e.accountId !== accountId) return false;
        if (fromDate && e.postedAt < new Date(fromDate)) return false;
        if (toDate   && e.postedAt > new Date(toDate))   return false;
        return true;
      })
      .slice(0, limit || Infinity);
  }

  async findByPeriod(periodKey) {
    return [...this.#transactions.values()]
      .filter(t => t.fiscalPeriod === periodKey && t.isPosted);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL VALIDATOR — Middleware / Domain Service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JournalValidator enforces all domain invariants before a transaction posts.
 *
 * This is the "bouncer" of the ledger. No transaction passes into the posting
 * engine without clearing every check here. Fail fast, fail clearly.
 */
class JournalValidator {
  constructor(accountRepository) {
    this.accountRepo = accountRepository;
  }

  /**
   * Full validation pipeline. Throws on first failure.
   * Order matters: structural checks before DB lookups to save I/O.
   */
  async validate(transaction) {
    this.#validateStructure(transaction);
    this.#validateBalance(transaction);
    await this.#validateAccounts(transaction);
    this.#validateCurrencyConsistency(transaction);
    this.#validateMinimumEntries(transaction);
  }

  #validateStructure(transaction) {
    if (!transaction.reference) {
      throw new LedgerError('Transaction reference is required', 'ERR_MISSING_REFERENCE');
    }
    if (!transaction.description) {
      throw new LedgerError('Transaction description is required', 'ERR_MISSING_DESCRIPTION');
    }
    if (!transaction.entries || transaction.entries.length < 2) {
      throw new LedgerError('Transaction must have at least 2 entries', 'ERR_INSUFFICIENT_ENTRIES');
    }
  }

  #validateBalance(transaction) {
    if (!transaction.isBalanced) {
      throw new ImbalancedEntryError(
        transaction.debitTotal.toDecimalString(),
        transaction.creditTotal.toDecimalString()
      );
    }
  }

  async #validateAccounts(transaction) {
    const accountChecks = transaction.entries.map(async entry => {
      const account = await this.accountRepo.findById(entry.accountId);
      if (!account) throw new AccountNotFoundError(entry.accountId);
      if (!account.isActive) {
        throw new LedgerError(
          `Account ${entry.accountId} is inactive`,
          'ERR_INACTIVE_ACCOUNT',
          { accountId: entry.accountId }
        );
      }
    });
    await Promise.all(accountChecks);
  }

  #validateCurrencyConsistency(transaction) {
    const currencies = new Set(transaction.entries.map(e => e.money.currency));
    if (currencies.size > 1) {
      // Multi-currency transactions are allowed but require explicit FX entry.
      // Flag for review — warn but don't block (some systems allow it).
      // In strict mode, throw:
      // throw new LedgerError('Multi-currency entries require FX conversion entries', 'ERR_CURRENCY_MISMATCH');
    }
  }

  #validateMinimumEntries(transaction) {
    const hasDebit  = transaction.entries.some(e => e.isDebit);
    const hasCredit = transaction.entries.some(e => e.isCredit);
    if (!hasDebit || !hasCredit) {
      throw new LedgerError(
        'Transaction must have at least one debit and one credit entry',
        'ERR_MISSING_ENTRY_SIDE'
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE CALCULATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BalanceEngine computes account balances from journal entries.
 *
 * Algorithm:
 *   balance = normal_balance_side_total - opposite_side_total
 *
 * For an ASSET account (normal=DEBIT):
 *   balance = Σ debits - Σ credits
 *
 * For a LIABILITY account (normal=CREDIT):
 *   balance = Σ credits - Σ debits
 *
 * A negative balance on an asset account is a "credit balance" — unusual
 * (e.g., an overdraft) and may trigger business rules in production.
 */
class BalanceEngine {
  constructor(transactionRepository) {
    this.txnRepo = transactionRepository;
  }

  async getAccountBalance(account, { asOf, periodKey } = {}) {
    const entries = await this.txnRepo.findEntriesByAccountId(account.id, {
      toDate: asOf,
    });

    let debitTotal  = new Decimal(0);
    let creditTotal = new Decimal(0);

    for (const entry of entries) {
      if (entry.isDebit)  debitTotal  = debitTotal.plus(entry.money.amount);
      if (entry.isCredit) creditTotal = creditTotal.plus(entry.money.amount);
    }

    const normalBalance = account.normalBalance;
    const balance = normalBalance === 'DEBIT'
      ? debitTotal.minus(creditTotal)
      : creditTotal.minus(debitTotal);

    return {
      accountId:    account.id,
      accountCode:  account.code,
      accountName:  account.name,
      accountType:  account.type,
      normalBalance,
      debitTotal:   debitTotal.toFixed(2),
      creditTotal:  creditTotal.toFixed(2),
      balance:      balance.toFixed(2),
      currency:     account.currency,
      asOf:         asOf || new Date().toISOString(),
    };
  }

  /**
   * Trial Balance — lists all accounts with their balances.
   * A valid trial balance has ΣDebit balances = ΣCredit balances.
   * This is the internal consistency check of the ledger.
   */
  async generateTrialBalance(accountRepository, { asOf } = {}) {
    const accounts = await accountRepository.findAll();
    const rows     = await Promise.all(
      accounts.map(a => this.getAccountBalance(a, { asOf }))
    );

    // Separate into normal-debit and normal-credit account groups
    const debitRows  = rows.filter(r => r.normalBalance === 'DEBIT');
    const creditRows = rows.filter(r => r.normalBalance === 'CREDIT');

    const totalDebits  = debitRows.reduce((s, r) => s.plus(new Decimal(r.balance)), new Decimal(0));
    const totalCredits = creditRows.reduce((s, r) => s.plus(new Decimal(r.balance)), new Decimal(0));

    const isBalanced = totalDebits.equals(totalCredits);

    return {
      title:         'Trial Balance',
      asOf:          asOf || new Date().toISOString(),
      rows,
      totalDebits:   totalDebits.toFixed(2),
      totalCredits:  totalCredits.toFixed(2),
      isBalanced,
      generatedAt:   new Date().toISOString(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSTING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PostingEngine — the core write path of the ledger.
 *
 * Implements ACID-safe posting with:
 *   1. Idempotency check (prevent duplicate posts via idempotency key)
 *   2. Validation via JournalValidator
 *   3. Period check (reject posts to closed periods)
 *   4. Freeze check (reject posts when ledger is frozen)
 *   5. Atomic persist (in production, wrapped in a DB transaction)
 *   6. Domain event emission for downstream consumers (event bus, webhooks)
 */
class PostingEngine {
  constructor({ transactionRepository, accountRepository, auditLog, eventBus }) {
    this.txnRepo     = transactionRepository;
    this.accountRepo = accountRepository;
    this.auditLog    = auditLog;
    this.eventBus    = eventBus;
    this.validator   = new JournalValidator(accountRepository);
    this.#isFrozen   = false;
    this.#freezeReason = null;
    this.#closedPeriods = new Set();
  }

  #isFrozen;
  #freezeReason;
  #closedPeriods;

  /**
   * Post a transaction to the ledger.
   *
   * This is the primary write operation. It is the only way to change
   * account balances. All other "balance changes" in the UI/API layer
   * must funnel through this method.
   *
   * @param {Transaction} transaction
   * @param {string} actor - User or system posting the transaction
   * @returns {Promise<Transaction>} The posted transaction
   */
  async post(transaction, actor = 'SYSTEM') {
    // ── Guard: Ledger freeze ────────────────────────────────────────────────
    if (this.#isFrozen) throw new FrozenLedgerError(this.#freezeReason);

    // ── Guard: Closed period ────────────────────────────────────────────────
    if (this.#closedPeriods.has(transaction.fiscalPeriod)) {
      throw new ClosedPeriodError(transaction.fiscalPeriod);
    }

    // ── Guard: Idempotency (prevent double-post) ────────────────────────────
    // If a request retries due to network timeout, the second POST with the
    // same idempotency key returns the already-posted transaction — no duplicate.
    const existing = await this.txnRepo.findByIdempotencyKey(transaction.idempotencyKey);
    if (existing) {
      if (existing.isPosted) return existing;  // idempotent success
      throw new DuplicateTransactionError(transaction.idempotencyKey);
    }

    // ── Validate all domain invariants ─────────────────────────────────────
    await this.validator.validate(transaction);

    // ── Mark posted & persist ──────────────────────────────────────────────
    // In production: wrap the following in a DB transaction (BEGIN/COMMIT).
    // Use PostgreSQL advisory locks per account to prevent concurrent
    // posts from creating phantom reads on balance calculations.
    transaction.markPosted();
    await this.txnRepo.save(transaction);

    // ── Audit log ──────────────────────────────────────────────────────────
    this.auditLog.write({
      action:     'POST_TRANSACTION',
      entityType: 'Transaction',
      entityId:   transaction.id,
      actor,
      before:     null,
      after:      transaction.toJSON(),
      metadata:   { reference: transaction.reference },
    });

    // ── Emit domain event for downstream consumers ─────────────────────────
    // Consumers: reconciliation service, reporting pipeline, webhooks, etc.
    this.eventBus.emit(LedgerEvent.TRANSACTION_POSTED, {
      transactionId: transaction.id,
      reference:     transaction.reference,
      fiscalPeriod:  transaction.fiscalPeriod,
      postedAt:      transaction.postedAt,
      entries:       transaction.entries.map(e => e.toJSON()),
    });

    return transaction;
  }

  /**
   * Reverse a posted transaction.
   *
   * Creates a mirror-image transaction with all debits and credits swapped.
   * The original transaction is marked REVERSED, preserving audit history.
   *
   * WHY REVERSAL INSTEAD OF DELETE: Deletions break the audit trail and
   * can cause ledger gaps. Reversals are the GAAP-compliant way to undo.
   */
  async reverse(transactionId, { reason, actor = 'SYSTEM', idempotencyKey } = {}) {
    const original = await this.txnRepo.findById(transactionId);

    if (!original) throw new AccountNotFoundError(transactionId);
    if (!original.isPosted) {
      throw new InvalidReversalError(transactionId, 'Transaction is not in POSTED status');
    }
    if (original.isReversed) {
      throw new InvalidReversalError(transactionId, 'Transaction has already been reversed');
    }
    if (this.#closedPeriods.has(original.fiscalPeriod)) {
      throw new ClosedPeriodError(original.fiscalPeriod);
    }

    // Swap debits and credits
    const reversalEntries = original.entries.map(entry => ({
      accountId:   entry.accountId,
      entryType:   entry.isDebit ? EntryType.CREDIT : EntryType.DEBIT,
      money:       entry.money,
      description: `REVERSAL: ${entry.description}`,
    }));

    const reversalTxn = new Transaction({
      idempotencyKey: idempotencyKey || `reversal-of-${transactionId}`,
      reference:      `REV-${original.reference}`,
      description:    `Reversal of: ${original.description}. Reason: ${reason}`,
      entries:        reversalEntries,
      fiscalPeriod:   FiscalPeriod.current(),
      reversalOfId:   transactionId,
      metadata:       { reversalReason: reason, originalId: transactionId },
    });

    await this.validator.validate(reversalTxn);
    reversalTxn.markPosted();
    await this.txnRepo.save(reversalTxn);

    // Mark original as reversed
    original.markReversed(reversalTxn.id);
    await this.txnRepo.save(original);  // update in-place (in DB: UPDATE WHERE version=N)

    this.auditLog.write({
      action:     'REVERSE_TRANSACTION',
      entityType: 'Transaction',
      entityId:   original.id,
      actor,
      before:     { status: TransactionStatus.POSTED },
      after:      { status: TransactionStatus.REVERSED, reversedById: reversalTxn.id },
      metadata:   { reason, reversalId: reversalTxn.id },
    });

    this.eventBus.emit(LedgerEvent.TRANSACTION_REVERSED, {
      originalId:     original.id,
      reversalId:     reversalTxn.id,
      reference:      reversalTxn.reference,
    });

    return { original, reversal: reversalTxn };
  }

  // ── Ledger Lifecycle Controls ────────────────────────────────────────────

  freeze(reason, actor) {
    this.#isFrozen    = true;
    this.#freezeReason = reason;
    this.auditLog.write({
      action: 'FREEZE_LEDGER', entityType: 'Ledger', entityId: 'GLOBAL',
      actor, before: { frozen: false }, after: { frozen: true, reason },
    });
    this.eventBus.emit(LedgerEvent.LEDGER_FROZEN, { reason, frozenAt: new Date() });
  }

  unfreeze(actor) {
    this.#isFrozen     = false;
    this.#freezeReason = null;
    this.auditLog.write({
      action: 'UNFREEZE_LEDGER', entityType: 'Ledger', entityId: 'GLOBAL',
      actor, before: { frozen: true }, after: { frozen: false },
    });
  }

  closePeriod(periodKey, actor) {
    if (this.#closedPeriods.has(periodKey)) {
      throw new LedgerError(`Period ${periodKey} is already closed`, 'ERR_PERIOD_ALREADY_CLOSED');
    }
    this.#closedPeriods.add(periodKey);
    this.auditLog.write({
      action: 'CLOSE_PERIOD', entityType: 'FiscalPeriod', entityId: periodKey,
      actor, before: { closed: false }, after: { closed: true },
    });
    this.eventBus.emit(LedgerEvent.PERIOD_CLOSED, { periodKey, closedAt: new Date(), closedBy: actor });
  }

  get frozenStatus() { return { isFrozen: this.#isFrozen, reason: this.#freezeReason }; }
  get closedPeriods() { return [...this.#closedPeriods]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATEMENT GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StatementGenerator — produces human/machine-readable account statements.
 * Analogous to a bank statement: opening balance, transactions, closing balance.
 */
class StatementGenerator {
  constructor({ transactionRepository, balanceEngine }) {
    this.txnRepo      = transactionRepository;
    this.balanceEngine = balanceEngine;
  }

  async generateAccountStatement(account, { fromDate, toDate } = {}) {
    const [openingBalance, entries] = await Promise.all([
      this.balanceEngine.getAccountBalance(account, { asOf: fromDate }),
      this.txnRepo.findEntriesByAccountId(account.id, { fromDate, toDate }),
    ]);

    let runningBalance = new Decimal(openingBalance.balance);

    const lines = entries.map(entry => {
      const amount  = entry.money.amount;
      const isNormalSide = (
        (account.normalBalance === 'DEBIT'  && entry.isDebit) ||
        (account.normalBalance === 'CREDIT' && entry.isCredit)
      );
      // Running balance: + for normal side, - for opposite side
      runningBalance = isNormalSide
        ? runningBalance.plus(amount)
        : runningBalance.minus(amount);

      return {
        date:           entry.postedAt.toISOString(),
        transactionId:  entry.transactionId,
        description:    entry.description,
        entryType:      entry.entryType,
        debit:          entry.isDebit  ? amount.toFixed(2) : null,
        credit:         entry.isCredit ? amount.toFixed(2) : null,
        balance:        runningBalance.toFixed(2),
      };
    });

    return {
      account:        account.toJSON(),
      period:         { from: fromDate, to: toDate },
      openingBalance: openingBalance.balance,
      lines,
      closingBalance: runningBalance.toFixed(2),
      currency:       account.currency,
      generatedAt:    new Date().toISOString(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER SERVICE — Application Service (orchestration layer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LedgerService — the public API for the ledger subsystem.
 *
 * This is the ONLY entry point for external code (REST handlers, GraphQL
 * resolvers, event consumers). It orchestrates domain objects without
 * exposing their internals.
 *
 * Clean Architecture: this layer depends inward on the domain,
 * never the other way around.
 */
class LedgerService {
  constructor({ accountRepository, transactionRepository, auditLog, eventBus }) {
    const repos = { accountRepository, transactionRepository, auditLog, eventBus };
    this.accountRepo  = accountRepository;
    this.txnRepo      = transactionRepository;
    this.auditLog     = auditLog;
    this.eventBus     = eventBus;

    this.postingEngine    = new PostingEngine(repos);
    this.balanceEngine    = new BalanceEngine(transactionRepository);
    this.statementGen     = new StatementGenerator({
      transactionRepository,
      balanceEngine: this.balanceEngine,
    });
  }

  // ── Account Management ───────────────────────────────────────────────────

  async createAccount(params, actor) {
    const account = new LedgerAccount(params);
    await this.accountRepo.save(account);
    this.auditLog.write({
      action: 'CREATE_ACCOUNT', entityType: 'Account', entityId: account.id,
      actor, before: null, after: account.toJSON(),
    });
    this.eventBus.emit(LedgerEvent.ACCOUNT_CREATED, account.toJSON());
    return account;
  }

  async getAccount(id) {
    const account = await this.accountRepo.findById(id);
    if (!account) throw new AccountNotFoundError(id);
    return account;
  }

  // ── Transaction Management ────────────────────────────────────────────────

  /**
   * Post a journal entry. Primary write operation.
   *
   * @param {Object} params
   * @param {string} params.reference    - Business reference (invoice #, PO #, etc.)
   * @param {string} params.description  - Human-readable description
   * @param {Array}  params.entries      - Array of { accountId, entryType, amount, currency }
   * @param {string} [params.idempotencyKey] - Caller-supplied deduplication key
   */
  async postJournalEntry(params, actor) {
    const transaction = new Transaction(params);
    return this.postingEngine.post(transaction, actor);
  }

  async reverseTransaction(transactionId, options, actor) {
    return this.postingEngine.reverse(transactionId, { ...options, actor });
  }

  async getTransaction(id) {
    const txn = await this.txnRepo.findById(id);
    if (!txn) throw new LedgerError(`Transaction not found: ${id}`, 'ERR_TXN_NOT_FOUND');
    return txn;
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  async getAccountBalance(accountId, options) {
    const account = await this.accountRepo.findById(accountId);
    if (!account) throw new AccountNotFoundError(accountId);
    return this.balanceEngine.getAccountBalance(account, options);
  }

  async getTrialBalance(options) {
    return this.balanceEngine.generateTrialBalance(this.accountRepo, options);
  }

  async getAccountStatement(accountId, options) {
    const account = await this.accountRepo.findById(accountId);
    if (!account) throw new AccountNotFoundError(accountId);
    return this.statementGen.generateAccountStatement(account, options);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  freezeLedger(reason, actor)   { this.postingEngine.freeze(reason, actor); }
  unfreezeLedger(actor)          { this.postingEngine.unfreeze(actor); }
  closePeriod(periodKey, actor)  { this.postingEngine.closePeriod(periodKey, actor); }
  getAuditLog(entityId)          { return this.auditLog.getHistory(entityId); }
  getFullAuditLog()              { return this.auditLog.getAll(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY — Dependency injection / composition root
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createLedgerEngine — assembles the complete ledger subsystem.
 *
 * In production, inject real repository implementations (Postgres),
 * a Redis-backed cache, and an event bus (Kafka/RabbitMQ/EventBridge).
 */
function createLedgerEngine({ eventBus } = {}) {
  const bus = eventBus || new EventEmitter();

  const accountRepository     = new InMemoryAccountRepository();
  const transactionRepository = new InMemoryTransactionRepository();
  const auditLog              = new AuditLog();

  const ledgerService = new LedgerService({
    accountRepository,
    transactionRepository,
    auditLog,
    eventBus: bus,
  });

  return { ledgerService, eventBus: bus };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE USAGE — Demonstrates a complete accounting workflow
// ─────────────────────────────────────────────────────────────────────────────

async function runLedgerExample() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Double-Entry Ledger Engine — Example Workflow');
  console.log('═══════════════════════════════════════════════════\n');

  const { ledgerService, eventBus } = createLedgerEngine();

  // Subscribe to domain events
  eventBus.on(LedgerEvent.TRANSACTION_POSTED, e =>
    console.log(`[EVENT] ${LedgerEvent.TRANSACTION_POSTED}:`, e.reference)
  );
  eventBus.on(LedgerEvent.TRANSACTION_REVERSED, e =>
    console.log(`[EVENT] ${LedgerEvent.TRANSACTION_REVERSED}: original=${e.originalId.slice(0,8)}`)
  );
  eventBus.on(LedgerEvent.PERIOD_CLOSED, e =>
    console.log(`[EVENT] ${LedgerEvent.PERIOD_CLOSED}: ${e.periodKey}`)
  );

  // 1. Create Chart of Accounts
  const [cash, ar, revenue, suspense] = await Promise.all([
    ledgerService.createAccount({ code: '1010', name: 'Cash',                 type: AccountType.ASSET },   'admin'),
    ledgerService.createAccount({ code: '1200', name: 'Accounts Receivable',  type: AccountType.ASSET },   'admin'),
    ledgerService.createAccount({ code: '4000', name: 'Service Revenue',      type: AccountType.REVENUE }, 'admin'),
    ledgerService.createAccount({ code: '2999', name: 'Suspense Account',     type: AccountType.LIABILITY, isSuspense: true }, 'admin'),
  ]);

  console.log('✔ Chart of Accounts created');

  // 2. Post a revenue transaction: DR Cash / CR Revenue
  //    (Customer pays $5,000 cash for consulting services)
  const revenueTxn = await ledgerService.postJournalEntry({
    reference:      'INV-2024-001',
    description:    'Cash receipt for consulting services',
    idempotencyKey: 'inv-2024-001-payment',
    entries: [
      { accountId: cash.id,    entryType: EntryType.DEBIT,  amount: 5000, currency: 'USD' },
      { accountId: revenue.id, entryType: EntryType.CREDIT, amount: 5000, currency: 'USD' },
    ],
  }, 'cashier');

  console.log(`\n✔ Posted: ${revenueTxn.reference} (ID: ${revenueTxn.id.slice(0,8)}...)`);

  // 3. Post an AR entry: DR AR / CR Revenue  (invoice on account)
  const arTxn = await ledgerService.postJournalEntry({
    reference:   'INV-2024-002',
    description: 'Invoice for Q1 consulting retainer',
    entries: [
      { accountId: ar.id,      entryType: EntryType.DEBIT,  amount: 12000, currency: 'USD' },
      { accountId: revenue.id, entryType: EntryType.CREDIT, amount: 12000, currency: 'USD' },
    ],
  }, 'billing');

  console.log(`✔ Posted: ${arTxn.reference}`);

  // 4. Demonstrate idempotency — re-posting with same key returns original
  const dupTxn = await ledgerService.postJournalEntry({
    reference:      'INV-2024-001-DUP',
    description:    'Duplicate attempt (should be idempotent)',
    idempotencyKey: 'inv-2024-001-payment',  // Same key as revenueTxn
    entries: [
      { accountId: cash.id,    entryType: EntryType.DEBIT,  amount: 5000, currency: 'USD' },
      { accountId: revenue.id, entryType: EntryType.CREDIT, amount: 5000, currency: 'USD' },
    ],
  }, 'cashier');
  console.log(`✔ Idempotent re-post returned same txn: ${dupTxn.id === revenueTxn.id}`);

  // 5. Get balances
  const cashBalance    = await ledgerService.getAccountBalance(cash.id);
  const revenueBalance = await ledgerService.getAccountBalance(revenue.id);

  console.log(`\n── Balances ──────────────────────────────────────`);
  console.log(`  Cash:            $${cashBalance.balance}`);
  console.log(`  Revenue:         $${revenueBalance.balance}`);

  // 6. Trial Balance
  const tb = await ledgerService.getTrialBalance();
  console.log(`\n── Trial Balance ─────────────────────────────────`);
  tb.rows.forEach(r => console.log(`  ${r.accountCode.padEnd(6)} ${r.accountName.padEnd(25)} ${r.balance.padStart(12)}`));
  console.log(`  ${''.padEnd(31)} ${'─'.repeat(12)}`);
  console.log(`  Debits:  $${tb.totalDebits}  Credits: $${tb.totalCredits}  Balanced: ${tb.isBalanced}`);

  // 7. Reverse a transaction
  const { reversal } = await ledgerService.reverseTransaction(
    revenueTxn.id,
    { reason: 'Customer payment returned (NSF cheque)' },
    'finance-manager'
  );
  console.log(`\n✔ Reversed: ${reversal.reference}`);

  // 8. Account Statement
  const statement = await ledgerService.getAccountStatement(cash.id);
  console.log(`\n── Cash Account Statement ────────────────────────`);
  statement.lines.forEach(l =>
    console.log(`  ${l.date.slice(0,10)} | ${l.description.slice(0,30).padEnd(30)} | DR:${(l.debit||'').padStart(8)} CR:${(l.credit||'').padStart(8)} | Bal:${l.balance.padStart(10)}`)
  );
  console.log(`  Closing Balance: $${statement.closingBalance}`);

  // 9. Close the fiscal period
  ledgerService.closePeriod(FiscalPeriod.current(), 'finance-controller');

  // 10. Attempt to post to closed period — should throw
  try {
    await ledgerService.postJournalEntry({
      reference: 'TEST-CLOSED',
      description: 'Post to closed period',
      fiscalPeriod: FiscalPeriod.current(),
      entries: [
        { accountId: cash.id,    entryType: EntryType.DEBIT,  amount: 100, currency: 'USD' },
        { accountId: revenue.id, entryType: EntryType.CREDIT, amount: 100, currency: 'USD' },
      ],
    }, 'test');
  } catch (e) {
    console.log(`\n✔ Correctly rejected closed period post: [${e.code}] ${e.message}`);
  }

  // 11. Audit trail
  const audit = ledgerService.getFullAuditLog();
  console.log(`\n── Audit Log (${audit.length} entries) ────────────────────`);
  audit.forEach(a => console.log(`  [${a.timestamp.slice(0,19)}] ${a.action.padEnd(25)} by ${a.actor}`));
  console.log('\n═══════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Factory
  createLedgerEngine,
  // Domain
  LedgerAccount,
  Transaction,
  JournalEntry,
  Money,
  AccountCode,
  FiscalPeriod,
  // Services
  LedgerService,
  PostingEngine,
  BalanceEngine,
  StatementGenerator,
  JournalValidator,
  // Repositories
  InMemoryAccountRepository,
  InMemoryTransactionRepository,
  AuditLog,
  // Errors
  LedgerError,
  ImbalancedEntryError,
  AccountNotFoundError,
  DuplicateTransactionError,
  FrozenLedgerError,
  ClosedPeriodError,
  InvalidReversalError,
  // Enums/Constants
  AccountType,
  EntryType,
  NormalBalance,
  TransactionStatus,
  LedgerEvent,
  // Example
  runLedgerExample,
};

// Run example if executed directly
if (require.main === module) {
  runLedgerExample().catch(err => {
    console.error('Ledger example failed:', err);
    process.exit(1);
  });
}