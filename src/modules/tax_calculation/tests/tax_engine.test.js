const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const ruleEngine = require('../rule_engine.js');
const { calculateSalaryTax, calculateCapitalGain, calculateMultipleCapitalGains } = require('../tax.service.js');

describe('Tax Engine - Golden Dataset Tests', () => {
  let taxConfig;

  beforeAll(() => {
    taxConfig = ruleEngine.getRules('PAKISTAN', 2026);
  });

  describe('Salary Income Classification & Progressive Slab', () => {
    it('should correctly calculate tax for income falling in the highest slab with no deductions', async () => {
      // Golden case: 8,000,000 PKR
      // Exceeds 7,000,000. 
      // Tax: 1,424,000 + 35% of (8,000,000 - 7,000,000)
      // Variable: 1,000,000 * 0.35 = 350,000
      // Total: 1,424,000 + 350,000 = 1,774,000

      const transaction = {
        transactionId: uuidv4(),
        taxFilerId: 'user1',
        assetType: 'SALARY',
        totalAmount: 8000000,
        calculationMetadata: { deductionsApplied: 0 }
      };

      const result = await calculateSalaryTax(transaction, taxConfig);
      
      expect(result.taxableGain).toBe('8000000');
      expect(result.taxLiability).toBe('1774000');
      expect(result.calculationMetadata.step_by_step_breakdown).toBeDefined();
      expect(result.calculationMetadata.step_by_step_breakdown.some(step => step.step === 'Apply Progressive Slab')).toBe(true);
    });

    it('should correctly apply deductions before calculating progressive tax', async () => {
      // Golden case: Gross 3,300,000 with 200,000 deduction = 3,100,000 taxable.
      // Falls in 2.2M to 3.2M slab.
      // Tax: 116,000 + 20% of (3,100,000 - 2,200,000)
      // Variable: 900,000 * 0.20 = 180,000
      // Total: 116,000 + 180,000 = 296,000

      const transaction = {
        transactionId: uuidv4(),
        taxFilerId: 'user2',
        assetType: 'SALARY',
        totalAmount: 3300000,
        calculationMetadata: { deductionsApplied: 200000 }
      };

      const result = await calculateSalaryTax(transaction, taxConfig);
      
      expect(result.taxableGain).toBe('3100000');
      expect(result.taxLiability).toBe('296000');
      
      const breakdown = result.calculationMetadata.step_by_step_breakdown;
      const deductionStep = breakdown.find(b => b.step === 'Apply Deductions');
      expect(deductionStep.deductionAmount).toBe('200000');
      expect(deductionStep.taxableIncome).toBe('3100000');
    });

    it('should calculate zero tax for income below exemption threshold', async () => {
      // Golden case: 500,000 PKR (Exempt threshold is 600,000)
      
      const transaction = {
        transactionId: uuidv4(),
        taxFilerId: 'user3',
        assetType: 'SALARY',
        totalAmount: 500000
      };

      const result = await calculateSalaryTax(transaction, taxConfig);
      
      expect(result.taxableGain).toBe('500000');
      expect(result.taxLiability).toBe('0');
    });
    
    it('should apply surcharge for high net worth individuals', async () => {
      // Golden case: 12,000,000 PKR
      // Exceeds 7,000,000. Tax: 1,424,000 + 35% of 5,000,000 = 3,174,000
      // Surcharge threshold is 10,000,000. So surcharge of 9% applies to the tax liability.
      // Surcharge: 3,174,000 * 0.09 = 285,660
      // Total Tax: 3,174,000 + 285,660 = 3,459,660

      const transaction = {
        transactionId: uuidv4(),
        taxFilerId: 'user-hnw',
        assetType: 'SALARY',
        totalAmount: 12000000
      };

      const result = await calculateSalaryTax(transaction, taxConfig);
      
      expect(result.taxableGain).toBe('12000000');
      expect(result.taxLiability).toBe('3459660');
      
      const breakdown = result.calculationMetadata.step_by_step_breakdown;
      const surchargeStep = breakdown.find(b => b.step === 'Income Surcharge');
      expect(surchargeStep).toBeDefined();
      expect(surchargeStep.surchargeAmount).toBe('285660');
    });
  });

  describe('Capital Gains Calculation', () => {
    it('should calculate flat regime capital gains for real estate acquired post-July 2024', async () => {
      const transaction = {
        transactionId: uuidv4(),
        taxFilerId: 'user4',
        assetType: 'REAL_ESTATE',
        acquisitionCostTotal: 10000000,
        disposalProceeds: 15000000,
        acquisitionDate: new Date('2024-08-01'), // Post July 2024
        disposalDate: new Date('2025-01-01'),
        acquisitionCostCurrency: 'PKR',
        currentValueCurrency: 'PKR',
        quantity: 1,
        jurisdiction: 'PAKISTAN',
        taxYear: 2026
      };

      const result = await calculateCapitalGain(transaction, taxConfig, undefined, 'ACTIVE_FILER');
      
      // Gain = 5M. Flat regime ACTIVE_FILER = 15% (0.15)
      // Liability = 5,000,000 * 0.15 = 750,000
      expect(result.taxableGain).toBe('5000000');
      expect(result.taxLiability).toBe('750000');
      expect(result.applicableTaxRate).toBe(0.15);
      expect(result.gainType).toBe('FLAT_REGIME');
    });

    it('should utilize loss carryforwards', async () => {
      const transaction = {
        transactionId: uuidv4(),
        taxFilerId: 'user5',
        assetType: 'SECURITIES',
        acquisitionCostTotal: 100000,
        disposalProceeds: 200000,
        acquisitionDate: new Date('2023-01-01'),
        disposalDate: new Date('2024-01-01'),
        acquisitionCostCurrency: 'PKR',
        currentValueCurrency: 'PKR',
        quantity: 1,
        jurisdiction: 'PAKISTAN',
        taxYear: 2026
      };

      const previousLoss = '50000';
      const result = await calculateCapitalGain(transaction, taxConfig, previousLoss, 'ACTIVE_FILER');
      
      // Raw Gain = 100,000. Carryforward = 50,000. Taxable Gain = 50,000.
      // Securities ACTIVE_FILER rate = 15% (0.15)
      // Liability = 50,000 * 0.15 = 7500
      
      expect(result.taxableGain).toBe('50000');
      expect(result.taxLiability).toBe('7500');
    });
  });
});
