/**
 * ============================================================================
 * DOMAIN CONSTANTS (ENUMS)
 * ============================================================================
 */

const AssetType = Object.freeze({
  SECURITIES: "SECURITIES",
  REAL_ESTATE: "REAL_ESTATE",
  CRYPTO: "CRYPTO",
  CASH_EQUIVALENT: "CASH_EQUIVALENT",
  PRECIOUS_METALS: "PRECIOUS_METALS"
});

const CapitalGainType = Object.freeze({
  SHORT_TERM: "SHORT_TERM",
  LONG_TERM: "LONG_TERM"
});

const TaxJurisdiction = Object.freeze({
  FEDERAL: "FEDERAL",
  PROVINCIAL: "PROVINCIAL",
  STATE: "STATE"
});

const IncomeType = Object.freeze({
  SALARY: "SALARY",
  CAPITAL_GAINS: "CAPITAL_GAINS",
  BUSINESS: "BUSINESS",
  OTHER: "OTHER"
});

/**
 * ============================================================================
 * CUSTOM ERROR CLASSES
 * ============================================================================
 */

class DataAccessError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "DataAccessError";
    this.context = context;
    if (Error.captureStackTrace) Error.captureStackTrace(this, DataAccessError);
  }
}

class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "ValidationError";
    this.errors = errors; // Array of specific validation issues
    if (Error.captureStackTrace) Error.captureStackTrace(this, ValidationError);
  }
}

class CurrencyConversionError extends Error {
  constructor(message, fromCurrency, toCurrency, context = {}) {
    super(message);
    this.name = "CurrencyConversionError";
    this.fromCurrency = fromCurrency;
    this.toCurrency = toCurrency;
    this.context = context;
    if (Error.captureStackTrace) Error.captureStackTrace(this, CurrencyConversionError);
  }
}

class TaxCalculationError extends Error {
  constructor(message, calculationContext = {}) {
    super(message);
    this.name = "TaxCalculationError";
    this.calculationContext = calculationContext;
    if (Error.captureStackTrace) Error.captureStackTrace(this, TaxCalculationError);
  }
}

/**
 * ============================================================================
 * RUNTIME VALIDATION FUNCTIONS
 * ============================================================================
 */

/**
 * Validates the core properties of an Asset payload
 */
function validateAsset(asset) {
  const errors = [];
  if (!asset.assetId) errors.push("assetId is required");
  if (!asset.taxFilerId) errors.push("taxFilerId is required");
  if (!asset.assetType || !Object.values(AssetType).includes(asset.assetType)) {
    errors.push(`Invalid assetType. Must be one of: ${Object.values(AssetType).join(", ")}`);
  }
  if (!asset.assetName || typeof asset.assetName !== "string") errors.push("assetName must be a valid string");
  if (typeof asset.quantity !== "number" || asset.quantity < 0) errors.push("quantity must be a non-negative number");
  if (typeof asset.currentValue !== "number" || asset.currentValue < 0) errors.push("currentValue must be a non-negative number");
  if (!asset.currency || asset.currency.length !== 3) errors.push("currency must be a 3-letter ISO code");
  if (!(asset.lastUpdated instanceof Date) && isNaN(Date.parse(asset.lastUpdated))) errors.push("lastUpdated must be a valid Date");

  if (errors.length > 0) {
    throw new ValidationError("Asset data validation failed", errors);
  }
  return true;
}

/**
 * Validates the structure of a Transaction payload
 */
function validateTransaction(transaction) {
  const errors = [];
  if (!transaction.transactionId) errors.push("transactionId is required");
  if (!transaction.taxFilerId) errors.push("taxFilerId is required");
  if (!transaction.assetId) errors.push("assetId is required");
  if (!transaction.transactionType) errors.push("transactionType is required");
  if (!(transaction.date instanceof Date) && isNaN(Date.parse(transaction.date))) errors.push("date must be a valid Date");
  if (typeof transaction.quantity !== "number" || transaction.quantity <= 0) errors.push("quantity must be greater than 0");
  if (typeof transaction.pricePerUnit !== "number" || transaction.pricePerUnit < 0) errors.push("pricePerUnit must be a non-negative number");
  if (!transaction.currency || transaction.currency.length !== 3) errors.push("currency must be a 3-letter ISO code");
  if (typeof transaction.totalAmount !== "number" || transaction.totalAmount < 0) errors.push("totalAmount must be a non-negative number");

  if (errors.length > 0) {
    throw new ValidationError("Transaction data validation failed", errors);
  }
  return true;
}

/**
 * Validates a generated tax calculation result
 */
function validateTaxCalculation(calculation) {
  const errors = [];
  if (typeof calculation.gainAmount !== "string" && typeof calculation.gainAmount !== "number") errors.push("gainAmount must be a string or number");
  if (typeof calculation.lossAmount !== "string" && typeof calculation.lossAmount !== "number") errors.push("lossAmount must be a string or number");
  if (typeof calculation.taxLiability !== "string" && typeof calculation.taxLiability !== "number") errors.push("taxLiability must be a string or number");
  if (calculation.gainType && !Object.values(CapitalGainType).includes(calculation.gainType) && !["FLAT_REGIME", "SLOTTED_REGIME"].includes(calculation.gainType)) {
    errors.push(`Invalid gainType.`);
  }

  if (errors.length > 0) {
    throw new TaxCalculationError("Tax calculation failed structural validation", { errors, calculation });
  }
  return true;
}

/**
 * Validates a tax filing envelope before committing to the audit log
 */
function validateTaxFiling(filing) {
  const errors = [];
  if (!filing.filingId) errors.push("filingId is required");
  if (!filing.taxYear || typeof filing.taxYear !== "number") errors.push("taxYear must be a valid year number");
  if (!filing.jurisdiction || !Object.values(TaxJurisdiction).includes(filing.jurisdiction)) {
    errors.push(`Invalid jurisdiction. Must be one of: ${Object.values(TaxJurisdiction).join(", ")}`);
  }
  if (!Array.isArray(filing.transactions)) errors.push("filing must contain an array of itemized transaction calculations");

  if (errors.length > 0) {
    throw new ValidationError("Tax filing validation failed", errors);
  }
  return true;
}

// Named CJS exports
module.exports = {
  AssetType,
  CapitalGainType,
  TaxJurisdiction,
  IncomeType,
  DataAccessError,
  ValidationError,
  CurrencyConversionError,
  TaxCalculationError,
  validateAsset,
  validateTransaction,
  validateTaxCalculation,
  validateTaxFiling
};