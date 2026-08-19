//tax.service - UPDATED with auto-generated transaction IDs

const Decimal = require("decimal.js");
const { v4: uuidv4 } = require("uuid");
const {
  ValidationError,
  CurrencyConversionError,
  TaxCalculationError,
  IncomeType
} = require("./types.js");
const ruleEngine = require("./rule_engine.js");

const {
  getAssetsByTaxFiler,
  getAssetById,
  upsertAsset,
  deleteAsset,
  saveTaxCalculation,
  getCalculationsByFilingId,
  getCalculationsByTaxFilerAndYear,
  saveTaxFiling,
  getFilingById,
  getFilingsByTaxFiler,
  getFilingByTaxFilerAndYear,
  updateFilingStatus,
  submitFiling,
  saveFiling,
  getCompleteFiling
} = require("./tax.repository.js");

// Module-level shared cache for currency conversion layer
const exchangeRateCache = new Map();

/**
 * ============================================================================
 * INPUT VALIDATION FUNCTIONS
 * ============================================================================
 */

function validateAssetTransaction(transaction) {
  // ✅ FIX: Auto-generate transactionId if not provided
  if (!transaction.transactionId || transaction.transactionId.trim() === "") {
    transaction.transactionId = `txn_${uuidv4()}`;
  }

  const validAssetTypes = ["STOCKS", "REAL_ESTATE", "CRYPTOCURRENCY", "COMMODITIES"];
  if (!validAssetTypes.includes(transaction.assetType)) {
    throw new ValidationError("Invalid asset type", {
      field: "assetType",
      receivedValue: transaction.assetType
    });
  }

  if (!(transaction.acquisitionDate instanceof Date)) {
    throw new ValidationError("Acquisition date must be a valid Date", {
      field: "acquisitionDate"
    });
  }

  if (
    transaction.disposalDate &&
    !(transaction.disposalDate instanceof Date)
  ) {
    throw new ValidationError("Disposal date must be a valid Date", {
      field: "disposalDate"
    });
  }

  if (
    transaction.disposalDate &&
    transaction.disposalDate < transaction.acquisitionDate
  ) {
    throw new ValidationError(
      "Disposal date must be after acquisition date",
      {
        field: "dates",
        acquisitionDate: transaction.acquisitionDate,
        disposalDate: transaction.disposalDate
      }
    );
  }

  if (transaction.quantity <= 0) {
    throw new ValidationError("Quantity must be greater than zero", {
      field: "quantity",
      value: transaction.quantity
    });
  }

  if (new Decimal(transaction.acquisitionCostPerUnit).isNegative()) {
    throw new ValidationError("Acquisition cost cannot be negative", {
      field: "acquisitionCostPerUnit",
      value: transaction.acquisitionCostPerUnit
    });
  }

  if (new Decimal(transaction.currentValuePerUnit).isNegative()) {
    throw new ValidationError("Current value cannot be negative", {
      field: "currentValuePerUnit",
      value: transaction.currentValuePerUnit
    });
  }

  if (
    !transaction.acquisitionCostCurrency ||
    transaction.acquisitionCostCurrency.length !== 3
  ) {
    throw new ValidationError(
      "Invalid acquisition currency code (must be 3 chars)",
      {
        field: "acquisitionCostCurrency",
        value: transaction.acquisitionCostCurrency
      }
    );
  }

  if (
    !transaction.currentValueCurrency ||
    transaction.currentValueCurrency.length !== 3
  ) {
    throw new ValidationError(
      "Invalid current value currency code (must be 3 chars)",
      {
        field: "currentValueCurrency",
        value: transaction.currentValueCurrency
      }
    );
  }

  const validJurisdictions = ["PAKISTAN"];
  if (!validJurisdictions.includes(transaction.jurisdiction)) {
    throw new ValidationError("Invalid tax jurisdiction", {
      field: "jurisdiction",
      value: transaction.jurisdiction
    });
  }

  const currentYear = new Date().getFullYear();
  if (transaction.taxYear < 1900 || transaction.taxYear > currentYear) {
    throw new ValidationError(
      "Tax year must be between 1900 and current year",
      {
        field: "taxYear",
        value: transaction.taxYear
      }
    );
  }
}

function validateTransactionBatch(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new ValidationError("Must provide at least one transaction", {
      field: "transactions",
      count: transactions?.length || 0
    });
  }

  if (transactions.length > 1000) {
    throw new ValidationError(
      "Cannot process more than 1000 transactions at once",
      {
        field: "transactions",
        count: transactions.length
      }
    );
  }

  const ids = new Set();
  transactions.forEach(t => {
    // Generate ID if missing (before checking for duplicates)
    if (!t.transactionId || t.transactionId.trim() === "") {
      t.transactionId = `txn_${uuidv4()}`;
    }
    
    if (ids.has(t.transactionId)) {
      throw new ValidationError("Duplicate transaction ID found", {
        duplicateId: t.transactionId
      });
    }
    ids.add(t.transactionId);
    validateAssetTransaction(t);
  });
}

/**
 * ============================================================================
 * CURRENCY CONVERSION LAYER
 * ============================================================================
 */

async function fetchExchangeRate(fromCurrency, toCurrency, date) {
  const cacheKey = `${fromCurrency}-${toCurrency}-${
    date.toISOString().split("T")[0]
  }`;

  if (exchangeRateCache.has(cacheKey)) {
    return exchangeRateCache.get(cacheKey);
  }

  const mockRates = {
    "USD-PKR": "278.5",
    "EUR-PKR": "305.2",
    "BTC-USD": "45000.00",
    "ETH-USD": "2500.00",
    "PKR-USD": "0.00359"
  };

  const rateKey = `${fromCurrency}-${toCurrency}`;
  const rate = mockRates[rateKey];

  if (!rate) {
    return null;
  }

  const exchangeRate = {
    fromCurrency,
    toCurrency,
    rate,
    timestamp: date,
    source: "CACHED"
  };

  exchangeRateCache.set(cacheKey, exchangeRate);
  return exchangeRate;
}

async function convertCurrency(amount, fromCurrency, toCurrency, date) {
  const auditLog = {
    logId: uuidv4(),
    timestamp: new Date(),
    action: "CURRENCY_CONVERSION",
    details: {
      amount,
      fromCurrency,
      toCurrency,
      date: date.toISOString()
    },
    actor: "SYSTEM",
    status: "SUCCESS"
  };

  if (fromCurrency === toCurrency) {
    return {
      convertedAmount: amount,
      rate: "1",
      auditLog
    };
  }

  try {
    const rate = await fetchExchangeRate(fromCurrency, toCurrency, date);

    if (!rate) {
      throw new CurrencyConversionError(
        `No exchange rate available for ${fromCurrency}/${toCurrency} on ${date.toISOString()}`,
        { fromCurrency, toCurrency, date }
      );
    }

    const amountDecimal = new Decimal(amount);
    const rateDecimal = new Decimal(rate.rate);
    const convertedAmount = amountDecimal.times(rateDecimal).toString();

    auditLog.ratesUsed = [rate];
    auditLog.details.rateUsed = rate.rate;
    auditLog.details.convertedAmount = convertedAmount;

    return {
      convertedAmount,
      rate: rate.rate,
      auditLog
    };
  } catch (error) {
    auditLog.status = "ERROR";
    auditLog.errorMessage = error instanceof Error ? error.message : "Unknown error";
    throw new CurrencyConversionError(
      `Failed to convert ${fromCurrency} to ${toCurrency}: ${
        error instanceof Error ? error.message : "Unknown"
      }`,
      {
        fromCurrency,
        toCurrency,
        originalError: error
      }
    );
  }
}

function clearExchangeRateCache() {
  exchangeRateCache.clear();
}

/**
 * ============================================================================
 * CORE TAX CALCULATION LAYER
 * ============================================================================
 */
/**
 * ============================================================================
 * PROGRESSIVE TAX & SALARY ENGINE
 * ============================================================================
 */

function calculateProgressiveTax(taxableIncome, brackets) {
  const amount = new Decimal(taxableIncome);
  const breakdown = [];
  
  if (amount.lessThanOrEqualTo(0)) {
    return { taxLiability: new Decimal(0), breakdown: [{ step: "Zero Income", description: "No tax on zero or negative income", calculatedTax: "0" }] };
  }

  let applicableBracket = brackets[0];
  for (const bracket of brackets) {
    if (amount.greaterThan(bracket.min)) {
      applicableBracket = bracket;
    }
  }

  const baseAmount = amount.minus(applicableBracket.min);
  const variableTax = baseAmount.times(applicableBracket.rate);
  const totalTax = new Decimal(applicableBracket.fixed).plus(variableTax);

  breakdown.push({
    step: "Apply Progressive Slab",
    description: applicableBracket.description,
    taxableIncome: amount.toString(),
    fixedTaxComponent: applicableBracket.fixed.toString(),
    variableTaxComponent: variableTax.toString(),
    calculatedTax: totalTax.toString()
  });

  return { taxLiability: totalTax, breakdown };
}

async function calculateSalaryTax(transaction, taxConfig) {
  const breakdown = [];
  
  try {
    const rawIncome = transaction.totalAmount || transaction.amount || transaction.disposalProceeds || 0;
    const incomeAmount = new Decimal(rawIncome.toString());
    
    breakdown.push({
      step: "Gross Income",
      description: "Initial gross salary income",
      amount: incomeAmount.toString()
    });

    // Deductions Engine
    const userDeductions = transaction.calculationMetadata?.deductionsApplied || 0;
    const deductionAmount = new Decimal(userDeductions.toString());
    
    let finalTaxableIncome = incomeAmount.minus(deductionAmount);
    if (finalTaxableIncome.isNegative()) finalTaxableIncome = new Decimal(0);
    
    breakdown.push({
      step: "Apply Deductions",
      description: "Deducted allowed expenses",
      deductionAmount: deductionAmount.toString(),
      taxableIncome: finalTaxableIncome.toString()
    });

    const { taxLiability, breakdown: slabBreakdown } = calculateProgressiveTax(finalTaxableIncome, taxConfig.progressiveTaxBracketsSalaried);
    breakdown.push(...slabBreakdown);

    let finalLiability = taxLiability;
    
    // Surcharge
    if (finalTaxableIncome.greaterThan(taxConfig.incomeSurcharge.threshold)) {
      const surcharge = finalLiability.times(taxConfig.incomeSurcharge.rate);
      finalLiability = finalLiability.plus(surcharge);
      breakdown.push({
        step: "Income Surcharge",
        description: `Applied ${taxConfig.incomeSurcharge.rate * 100}% surcharge for income > ${taxConfig.incomeSurcharge.threshold}`,
        surchargeAmount: surcharge.toString(),
        totalTax: finalLiability.toString()
      });
    }

    const calculation = {
      transactionId: transaction.transactionId || uuidv4(),
      assetType: "SALARY",
      gainType: "N/A",
      gainAmount: finalTaxableIncome.toString(),
      lossAmount: "0",
      applicableTaxRate: "PROGRESSIVE",
      taxableGain: finalTaxableIncome.toString(),
      taxLiability: finalLiability.toString(),
      calculatedAt: new Date(),
      calculationMetadata: {
        step_by_step_breakdown: breakdown,
        deductionsApplied: deductionAmount.toString(),
        notes: ["Calculated using progressive salary slabs"]
      }
    };
    return calculation;
  } catch (error) {
    throw new TaxCalculationError("SALARY_CALCULATION_FAILED", `Failed to calculate salary tax: ${error.message}`, { transaction });
  }
}

async function calculateCapitalGain(transaction, taxConfig, previousLossCarryforward, filerStatus = "ACTIVE_FILER") {
  const auditTrail = [];
  const breakdown = [];

  try {
    const validationLog = {
      logId: uuidv4(),
      timestamp: new Date(),
      action: "INPUT_VALIDATION",
      details: { transactionId: transaction?.transactionId || "UNKNOWN" },
      actor: "SYSTEM",
      status: "SUCCESS"
    };
    auditTrail.push(validationLog);
    breakdown.push({
      step: "Validation",
      description: "Validated transaction inputs",
      status: "SUCCESS"
    });

    // -------------------------------------------------------------------------
    // 1. DEFENSIVE KEY MAPPING (Prevents [DecimalError] Invalid argument: undefined)
    // -------------------------------------------------------------------------
    if (!transaction) {
      throw new Error("Transaction object payload is undefined or null");
    }

    const quantity = transaction.quantity || 1;
    
    // Check common payload property aliases for acquisition cost
    const rawAcquisitionCost = transaction.acquisitionCostPerUnit || 
                               transaction.acquisitionCostTotal || 
                               transaction.acquisitionCost;
                               
    // Check common payload property aliases for selling price/current value
    const rawDisposalValue = transaction.disposalProceeds || 
                             transaction.sellingPrice || 
                             transaction.currentValuePerUnit || 
                             transaction.currentValue || 
                             transaction.disposalValue;

    if (rawAcquisitionCost === undefined || rawDisposalValue === undefined) {
      throw new Error(`Missing cost fields. Acquisition: ${rawAcquisitionCost}, Disposal/CurrentValue: ${rawDisposalValue}`);
    }

    // Safely verify and parse date objects
    const acquisitionDate = transaction.acquisitionDate ? new Date(transaction.acquisitionDate) : new Date();
    const disposalDate = transaction.disposalDate ? new Date(transaction.disposalDate) : new Date();

    if (isNaN(acquisitionDate.getTime()) || isNaN(disposalDate.getTime())) {
      throw new Error("Invalid date format provided for acquisitionDate or disposalDate");
    }

    // -------------------------------------------------------------------------
    // 2. HOLDING PERIOD CALCULATIONS
    // -------------------------------------------------------------------------
    const holdingMilliseconds = disposalDate.getTime() - acquisitionDate.getTime();
    const holdingDays = Math.floor(holdingMilliseconds / (1000 * 60 * 60 * 24));
    const holdingYears = Math.floor(holdingDays / 365.25);
    const holdingMonths = Math.floor((holdingDays % 365.25) / 30.44);
    const holdingDaysRemainder = Math.floor(holdingDays % 30.44);

    const holdingLog = {
      logId: uuidv4(),
      timestamp: new Date(),
      action: "HOLDING_PERIOD_CALCULATED",
      details: {
        acquisitionDate: acquisitionDate.toISOString(),
        disposalDate: disposalDate.toISOString(),
        holdingDays
      },
      actor: "SYSTEM",
      status: "SUCCESS"
    };
    auditTrail.push(holdingLog);

    // -------------------------------------------------------------------------
    // 3. CURRENCY CONVERSIONS WITH DECIMAL.JS SAFETY
    // -------------------------------------------------------------------------
    // Normalize total acquisition cost calculation based on payload shape
    const acqCostString = transaction.acquisitionCostTotal && !transaction.acquisitionCostPerUnit
      ? new Decimal(rawAcquisitionCost.toString()).toString()
      : new Decimal(rawAcquisitionCost.toString()).times(quantity).toString();

    const {
      convertedAmount: acqCostConverted,
      auditLog: acqConversionLog
    } = await convertCurrency(
      acqCostString,
      transaction.acquisitionCostCurrency || "PKR",
      "PKR",
      acquisitionDate
    );
    auditTrail.push(acqConversionLog);

    // Normalize total disposal values
    const disposalString = (transaction.disposalProceeds || transaction.disposalValue) && !transaction.currentValuePerUnit
      ? new Decimal(rawDisposalValue.toString()).toString()
      : new Decimal(rawDisposalValue.toString()).times(quantity).toString();

    const {
      convertedAmount: currentValueConverted,
      auditLog: currentConversionLog
    } = await convertCurrency(
      disposalString,
      transaction.currentValueCurrency || transaction.disposalCurrency || "PKR",
      "PKR",
      disposalDate
    );
    auditTrail.push(currentConversionLog);

    const acquisitionCostDecimal = new Decimal(acqCostConverted);
    const disposalProceeds = new Decimal(currentValueConverted);
    const rawGain = disposalProceeds.minus(acquisitionCostDecimal);

    // -------------------------------------------------------------------------
    // 4. TAX YEAR 2026 REGULATORY RATE RESOLUTION (FBR COMPLIANCE)
    // -------------------------------------------------------------------------
    let applicableTaxRate = 0;
    const targetStatus = filerStatus.toUpperCase();

    if (transaction.assetType === "REAL_ESTATE") {
      const cutOffDate = new Date("2024-07-01");
      
      if (acquisitionDate >= cutOffDate) {
        // Flat Tax Regime (Holding period ignored for assets bought post-July 2024)
        applicableTaxRate = taxConfig.capitalGainsTax.realEstate.acquiredPostJuly2024[targetStatus] || 0.15;
      } else {
        // Legacy Slotted Regime (Assets bought pre-July 2024)
        const schedules = taxConfig.capitalGainsTax.realEstate.acquiredPreJuly2024;
        const matchedTier = schedules.find(tier => tier.maxHoldingPeriodYears === null || holdingYears < tier.maxHoldingPeriodYears);
        applicableTaxRate = targetStatus === "NON_FILER" ? matchedTier.nonFilerRate : matchedTier.activeFilerRate;
      }
    } else if (transaction.assetType === "SECURITIES") {
      applicableTaxRate = taxConfig.capitalGainsTax.securities[targetStatus] || 0.15;
    } else {
      // General/Fallback asset rate handling
      applicableTaxRate = taxConfig.shortTermGainTaxRate || 0.25;
    }

    // -------------------------------------------------------------------------
    // 5. ALLOWABLE DEDUCTIONS & CARRYFORWARD MATCHING
    // -------------------------------------------------------------------------
    // Apply user documented deductions instead of arbitrary mathematical multipliers
    const userDeductions = transaction.calculationMetadata?.deductionsApplied || 0;
    const deductionAmount = new Decimal(userDeductions.toString());
    
    let finalTaxableGain = rawGain.minus(deductionAmount);
    if (finalTaxableGain.isNegative()) {
      finalTaxableGain = new Decimal(0);
    }

    let carryforwardUsed = new Decimal(0);
    if (previousLossCarryforward && finalTaxableGain.isPositive()) {
      const carryforward = new Decimal(previousLossCarryforward);
      carryforwardUsed = finalTaxableGain.lessThan(carryforward) ? finalTaxableGain : carryforward;
      finalTaxableGain = finalTaxableGain.minus(carryforwardUsed);
    }

    const taxLiability = finalTaxableGain.times(applicableTaxRate);
    breakdown.push({
      step: "Calculate Tax Liability",
      description: `Applied ${(applicableTaxRate * 100).toFixed(2)}% rate`,
      taxableGain: finalTaxableGain.toString(),
      rate: applicableTaxRate.toString(),
      calculatedTax: taxLiability.toString()
    });

    let gainAmount = "0";
    let lossAmount = "0";
    if (rawGain.isPositive()) {
      gainAmount = rawGain.toString();
    } else {
      lossAmount = rawGain.abs().toString();
    }

    const taxCalcLog = {
      logId: uuidv4(),
      timestamp: new Date(),
      action: "TAX_CALCULATED",
      details: {
        acquisitionCost: acqCostConverted,
        disposalProceeds: currentValueConverted,
        rawGain: rawGain.toString(),
        deduction: deductionAmount.toString(),
        taxableGain: finalTaxableGain.toString(),
        applicableTaxRate: (applicableTaxRate * 100).toFixed(2) + "%",
        taxLiability: taxLiability.toString(),
        carryforwardUsed: carryforwardUsed.toString()
      },
      actor: "SYSTEM",
      status: "SUCCESS"
    };
    auditTrail.push(taxCalcLog);

    // -------------------------------------------------------------------------
    // 6. BUILD FINAL RESPONSE DTO
    // -------------------------------------------------------------------------
    const calculation = {
      transactionId: transaction.transactionId || uuidv4(),
      assetType: transaction.assetType,
      gainType: rawGain.isNegative() ? "LOSS" : (acquisitionDate >= new Date("2024-07-01") ? "FLAT_REGIME" : "SLOTTED_REGIME"),
      acquisitionCostTotal: acqCostConverted,
      disposalProceeds: currentValueConverted,
      gainAmount,
      lossAmount,
      holdingDays,
      holdingDuration: {
        years: holdingYears,
        months: holdingMonths,
        days: holdingDaysRemainder
      },
      applicableTaxRate,
      taxableGain: finalTaxableGain.toString(),
      taxLiability: taxLiability.toString(),
      calculatedAt: new Date(),
      calculationMetadata: {
        exchangeRatesUsed: auditTrail.filter(log => log.ratesUsed).flatMap(log => log.ratesUsed),
        bracketApplied: transaction.assetType === "REAL_ESTATE" ? (acquisitionDate >= new Date("2024-07-01") ? "POST_JULY_2024_FLAT" : "PRE_JULY_2024_SLOTTED") : "STANDARD",
        deductionsApplied: deductionAmount.toString(),
        step_by_step_breakdown: breakdown,
        notes: [
          `FBR Regime: ${transaction.assetType} calculated for ${targetStatus}`,
          `Holding timeline: ${holdingYears}y ${holdingMonths}m ${holdingDaysRemainder}d`
        ]
      }
    };

    return calculation;
  } catch (error) {
    if (error instanceof TaxCalculationError) {
      throw error;
    }
    throw new TaxCalculationError(
      "CALCULATION_FAILED",
      `Failed to calculate capital gain: ${error instanceof Error ? error.message : "Unknown"}`,
      { transaction, originalError: error }
    );
  }
}


async function calculateMultipleCapitalGains(transactions, taxConfig) {
  validateTransactionBatch(transactions);

  const calculations = [];
  const auditTrail = [];
  let carryforwardLoss = new Decimal(0);

  const sortedTransactions = [...transactions].sort(
    (a, b) => a.acquisitionDate.getTime() - b.acquisitionDate.getTime()
  );

  for (const transaction of sortedTransactions) {
    try {
      let calculation;
      if (transaction.transactionType === "SALARY" || transaction.assetType === "SALARY") {
        calculation = await calculateSalaryTax(transaction, taxConfig);
      } else {
        calculation = await calculateCapitalGain(
          transaction,
          taxConfig,
          carryforwardLoss.isPositive() ? carryforwardLoss.toString() : undefined
        );

        const lossAmount = new Decimal(calculation.lossAmount || 0);
        if (lossAmount.isPositive()) {
          carryforwardLoss = carryforwardLoss.plus(lossAmount);
        } else if (
          carryforwardLoss.isPositive() &&
          new Decimal(calculation.taxableGain).isPositive()
        ) {
          carryforwardLoss = carryforwardLoss.minus(
            new Decimal(calculation.taxableGain).plus(lossAmount)
          );
        }
      }
      calculations.push(calculation);

    } catch (error) {
      const errorLog = {
        logId: uuidv4(),
        timestamp: new Date(),
        action: "CALCULATION_ERROR",
        details: { transactionId: transaction.transactionId },
        actor: "SYSTEM",
        status: "ERROR",
        errorMessage: error instanceof Error ? error.message : "Unknown error"
      };
      auditTrail.push(errorLog);
      throw error;
    }
  }

  return { calculations, auditTrail };
}

/**
 * ============================================================================
 * TAX FILING AGGREGATION LAYER
 * ============================================================================
 */

function createTaxFilingSummary(taxFilerId, taxYear, jurisdiction, calculations, auditLog = []) {
  const filingId = uuidv4();

  let totalCapitalGains = new Decimal(0);
  let totalCapitalLosses = new Decimal(0);

  const gainsByAssetType = {};
  const assetTypes = ["STOCKS", "REAL_ESTATE", "CRYPTOCURRENCY", "COMMODITIES"];
  for (const assetType of assetTypes) {
    gainsByAssetType[assetType] = {
      totalGain: "0",
      count: 0,
      avgTaxRate: 0
    };
  }

  let totalTaxLiability = new Decimal(0);
  let totalTransactionCount = 0;
  const allAuditEntries = [...auditLog];

  for (const calc of calculations) {
    const gain = new Decimal(calc.gainAmount || 0);
    const loss = new Decimal(calc.lossAmount || 0);
    const tax = new Decimal(calc.taxLiability);

    totalCapitalGains = totalCapitalGains.plus(gain);
    totalCapitalLosses = totalCapitalLosses.plus(loss);
    totalTaxLiability = totalTaxLiability.plus(tax);
    totalTransactionCount++;

    const assetSummary = gainsByAssetType[calc.assetType];
    if (assetSummary) {
      assetSummary.totalGain = new Decimal(assetSummary.totalGain).plus(gain).toString();
      assetSummary.count++;
      assetSummary.avgTaxRate =
        (assetSummary.avgTaxRate * (assetSummary.count - 1) + calc.applicableTaxRate) /
        assetSummary.count;
    }

    allAuditEntries.push({
      logId: uuidv4(),
      timestamp: new Date(),
      action: "TRANSACTION_INCLUDED_IN_FILING",
      details: {
        transactionId: calc.transactionId,
        gain: calc.gainAmount,
        loss: calc.lossAmount,
        tax: calc.taxLiability
      },
      actor: "SYSTEM",
      status: "SUCCESS"
    });
  }

  const netCapitalGain = totalCapitalGains.minus(totalCapitalLosses);

  let capitalLossCarryforward = new Decimal(0);
  const carryforwardExpiryYear = taxYear + 5;

  if (netCapitalGain.isNegative()) {
    capitalLossCarryforward = netCapitalGain.abs();
  }

  const summary = {
    filingId,
    taxFilerId,
    taxYear,
    jurisdiction,
    filingDate: new Date(),
    totalCapitalGains: totalCapitalGains.toString(),
    totalCapitalLosses: totalCapitalLosses.toString(),
    netCapitalGain: netCapitalGain.toString(),
    totalTaxLiability: totalTaxLiability.toString(),
    estimatedTaxPayable: totalTaxLiability.toString(),
    gainsByAssetType,
    capitalLossCarryforward: capitalLossCarryforward.toString(),
    carryforwardExpiryYear,
    transactionCount: totalTransactionCount,
    transactions: calculations,
    auditLog: allAuditEntries,
    lastModified: new Date()
  };

  return summary;
}

/**
 * ============================================================================
 * SERVICE ORCHESTRATION LAYER - WITH REPOSITORY INTEGRATION
 * ============================================================================
 */

async function calculateCompleteTaxFiling(db, taxFilerId, transactions, taxConfig) {
  const localAuditLog = [];
  
  const startLog = {
    logId: uuidv4(),
    timestamp: new Date(),
    action: "TAX_CALCULATION_STARTED",
    details: {
      taxFilerId,
      transactionCount: transactions.length,
      jurisdiction: taxConfig.jurisdiction,
      taxYear: taxConfig.taxYear
    },
    actor: "SYSTEM",
    status: "SUCCESS"
  };
  localAuditLog.push(startLog);

  try {
    validateTransactionBatch(transactions);

    const {
      calculations,
      auditTrail
    } = await calculateMultipleCapitalGains(transactions, taxConfig);
    localAuditLog.push(...auditTrail);

    const summary = createTaxFilingSummary(
      taxFilerId,
      taxConfig.taxYear,
      taxConfig.jurisdiction,
      calculations,
      localAuditLog
    );

    const completionLog = {
      logId: uuidv4(),
      timestamp: new Date(),
      action: "TAX_CALCULATION_COMPLETED",
      details: {
        filingId: summary.filingId,
        totalTaxLiability: summary.totalTaxLiability,
        transactionCount: summary.transactionCount
      },
      actor: "SYSTEM",
      status: "SUCCESS"
    };
    localAuditLog.push(completionLog);

    summary.auditLog = localAuditLog;
    return summary;
  } catch (error) {
    const errorLog = {
      logId: uuidv4(),
      timestamp: new Date(),
      action: "TAX_CALCULATION_FAILED",
      details: { error: error instanceof Error ? error.message : "Unknown" },
      actor: "SYSTEM",
      status: "ERROR",
      errorMessage: error instanceof Error ? error.message : "Unknown error"
    };
    localAuditLog.push(errorLog);

    if (error instanceof TaxCalculationError) {
      throw error;
    }

    throw new TaxCalculationError(
      "ORCHESTRATION_FAILED",
      `Tax calculation failed: ${
        error instanceof Error ? error.message : "Unknown"
      }`,
      { originalError: error },
      "HIGH"
    );
  }
}

/**
 * ============================================================================
 * PERSISTENCE LAYER - SAVE AND RETRIEVE WITH REPOSITORY
 * ============================================================================
 */

async function saveCompleteFilingWithCalculations(db, taxFilerId, summary) {
  try {
    const filing = {
      filingId: summary.filingId,
      taxYear: summary.taxYear,
      jurisdiction: summary.jurisdiction,
      totalTaxLiability: summary.totalTaxLiability,
      netCapitalGain: summary.netCapitalGain,
      transactions: summary.transactions,
      auditLog: summary.auditLog
    };

    const result = saveFiling(db, taxFilerId, filing);
    return result;
  } catch (error) {
    throw new TaxCalculationError(
      "PERSISTENCE_FAILED",
      `Failed to save tax filing: ${error instanceof Error ? error.message : "Unknown"}`,
      { error }
    );
  }
}

async function retrieveFilingWithCalculations(db, filingId) {
  try {
    return getCompleteFiling(db, filingId);
  } catch (error) {
    throw new TaxCalculationError(
      "RETRIEVAL_FAILED",
      `Failed to retrieve filing: ${error instanceof Error ? error.message : "Unknown"}`,
      { error }
    );
  }
}

async function retrieveFilingsByYear(db, taxFilerId, taxYear) {
  try {
    return getFilingByTaxFilerAndYear(db, taxFilerId, taxYear);
  } catch (error) {
    throw new TaxCalculationError(
      "RETRIEVAL_FAILED",
      `Failed to retrieve filing for year ${taxYear}: ${
        error instanceof Error ? error.message : "Unknown"
      }`,
      { error }
    );
  }
}

/**
 * ============================================================================
 * JURISDICTION JURISPRUDENCE (TAX PROVIDERS)
 * ============================================================================
 */
async function fetchPakistanTaxRates() {
  return ruleEngine.getRules("PAKISTAN", 2026);
}

async function calculatePakistanTax(db, transaction) {
  const taxConfig = ruleEngine.getRules("PAKISTAN", 2026);
  const summary = await calculateCompleteTaxFiling(
    db,
    transaction.taxFilerId,
    [transaction],
    taxConfig
  );
  return summary.transactions[0];
}

// CJS Named & Default module layer maps
module.exports = {
  default: calculateCompleteTaxFiling,
  validateAssetTransaction,
  validateTransactionBatch,
  convertCurrency,
  clearExchangeRateCache,
  calculateCapitalGain,
  calculateSalaryTax,
  calculateMultipleCapitalGains,
  createTaxFilingSummary,
  calculateCompleteTaxFiling,
  saveCompleteFilingWithCalculations,
  retrieveFilingWithCalculations,
  retrieveFilingsByYear,
  fetchPakistanTaxRates,
  calculatePakistanTax
};