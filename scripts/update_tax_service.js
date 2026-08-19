const fs = require('fs');
const path = require('path');

const filePath = path.join('e:', 'WealthFlux', 'backend', 'src', 'modules', 'tax_calculation', 'tax.service.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add RuleEngine import
content = content.replace(
  `} = require("./types.js");`,
  `} = require("./types.js");\nconst ruleEngine = require("./rule_engine.js");`
);

// 2. Add calculateProgressiveTax and calculateSalaryTax before calculateCapitalGain
const progressiveLogic = `
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
      description: 'Deducted allowed expenses',
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
        description: \`Applied \${taxConfig.incomeSurcharge.rate * 100}% surcharge for income > \${taxConfig.incomeSurcharge.threshold}\`,
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
    throw new TaxCalculationError("SALARY_CALCULATION_FAILED", \`Failed to calculate salary tax: \${error.message}\`, { transaction });
  }
}

async function calculateCapitalGain`;

content = content.replace('async function calculateCapitalGain', progressiveLogic);

// 3. Update calculateCapitalGain to return breakdown
content = content.replace(
  'const auditTrail = [];',
  'const auditTrail = [];\n  const breakdown = [];'
);

content = content.replace(
  'auditTrail.push(validationLog);',
  'auditTrail.push(validationLog);\n    breakdown.push({\n      step: "Validation",\n      description: "Validated transaction inputs",\n      status: "SUCCESS"\n    });'
);

content = content.replace(
  'const taxLiability = finalTaxableGain.times(applicableTaxRate);',
  `const taxLiability = finalTaxableGain.times(applicableTaxRate);
    breakdown.push({
      step: "Calculate Tax Liability",
      description: \`Applied \${(applicableTaxRate * 100).toFixed(2)}% rate\`,
      taxableGain: finalTaxableGain.toString(),
      rate: applicableTaxRate.toString(),
      calculatedTax: taxLiability.toString()
    });`
);

content = content.replace(
  'notes: [',
  'step_by_step_breakdown: breakdown,\n        notes: ['
);

// 4. Update calculateMultipleCapitalGains to handle salary
content = content.replace(
  'const calculation = await calculateCapitalGain(',
  `let calculation;
      if (transaction.transactionType === "SALARY" || transaction.assetType === "SALARY") {
        calculation = await calculateSalaryTax(transaction, taxConfig);
      } else {
        calculation = await calculateCapitalGain(`
);

content = content.replace(
  '      calculations.push(calculation);\n    } catch (error) {',
  `      }
      calculations.push(calculation);
    } catch (error) {`
);

// 5. Replace Jurisprudence section completely
const jurisprudenceRegex = /\/\*\*\n \* ============================================================================\n \* JURISDICTION JURISPRUDENCE \(TAX PROVIDERS\)\n \* ============================================================================\n \*\/[\s\S]*?(?=\n\/\/ CJS Named & Default module layer maps)/g;

const newJurisprudence = `/**
 * ============================================================================
 * JURISDICTION JURISPRUDENCE (TAX PROVIDERS)
 * ============================================================================
 */

async function fetchPakistanTaxRates() {
  // Backward compatibility wrapper
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
}`;

content = content.replace(jurisprudenceRegex, newJurisprudence);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated tax.service.js');
