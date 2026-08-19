// tests/unit/budgets.service.test.js
const { budgetsService } = require('../../src/modules/budgets/budgets.service');

describe('Budgets Service (Unit Tests)', () => {
  describe('createBudget()', () => {
    it('should create budget with valid data', async () => {
      const budgetData = {
        userId: 'user-123',
        category: 'food',
        limit: 500.00,
        startDate: new Date('2026-06-01'),
        endDate: new Date('2026-06-30'),
      };

      const result = await budgetsService.createBudget(budgetData);

      expect(result).toBeDefined();
      expect(result.category).toBe('food');
      expect(result.limit).toBe(500.00);
      expect(result.spent).toBe(0);
    });

    it('should reject budget with missing required fields', async () => {
      const invalidData = {
        userId: 'user-123',
        category: 'food',
        // missing limit, startDate, endDate
      };

      await expect(budgetsService.createBudget(invalidData)).rejects.toThrow();
    });

    it('should reject budget with zero or negative limit', async () => {
      const invalidData = {
        userId: 'user-123',
        category: 'food',
        limit: -100.00,
        startDate: new Date('2026-06-01'),
        endDate: new Date('2026-06-30'),
      };

      await expect(budgetsService.createBudget(invalidData)).rejects.toThrow(
        'Budget limit must be positive'
      );
    });

    it('should reject budget with invalid date range', async () => {
      const invalidData = {
        userId: 'user-123',
        category: 'food',
        limit: 500.00,
        startDate: new Date('2026-06-30'),
        endDate: new Date('2026-06-01'), // End before start
      };

      await expect(budgetsService.createBudget(invalidData)).rejects.toThrow(
        'End date must be after start date'
      );
    });

    it('should reject budget with past start date', async () => {
      const invalidData = {
        userId: 'user-123',
        category: 'food',
        limit: 500.00,
        startDate: new Date('2020-06-01'),
        endDate: new Date('2026-06-30'),
      };

      await expect(budgetsService.createBudget(invalidData)).rejects.toThrow(
        'Start date cannot be in the past'
      );
    });
  });

  describe('getBudgetById()', () => {
    it('should retrieve budget by ID', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.getBudgetById(budgetId);

      expect(result).toBeDefined();
      expect(result.id).toBe(budgetId);
    });

    it('should throw error for non-existent budget', async () => {
      const nonExistentId = 'invalid-budget-id';

      await expect(budgetsService.getBudgetById(nonExistentId)).rejects.toThrow(
        'Budget not found'
      );
    });
  });

  describe('getBudgetsByUserId()', () => {
    it('should retrieve all budgets for user', async () => {
      const userId = 'user-123';

      const result = await budgetsService.getBudgetsByUserId(userId);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((budget) => {
        expect(budget.userId).toBe(userId);
      });
    });

    it('should retrieve only active budgets', async () => {
      const userId = 'user-123';
      const filters = { activeOnly: true };

      const result = await budgetsService.getBudgetsByUserId(userId, filters);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((budget) => {
        const today = new Date();
        expect(new Date(budget.startDate) <= today).toBe(true);
        expect(new Date(budget.endDate) >= today).toBe(true);
      });
    });
  });

  describe('updateBudget()', () => {
    it('should update budget limit', async () => {
      const budgetId = 'budget-123';
      const updateData = {
        limit: 600.00,
      };

      const result = await budgetsService.updateBudget(budgetId, updateData);

      expect(result).toBeDefined();
      expect(result.limit).toBe(600.00);
    });

    it('should not allow updating to lower limit than spent', async () => {
      const budgetId = 'budget-123';
      const updateData = {
        limit: 50.00, // Lower than spent amount
      };

      await expect(budgetsService.updateBudget(budgetId, updateData)).rejects.toThrow(
        'New limit cannot be less than already spent amount'
      );
    });

    it('should throw error for non-existent budget', async () => {
      const nonExistentId = 'invalid-budget-id';
      const updateData = { limit: 600.00 };

      await expect(budgetsService.updateBudget(nonExistentId, updateData)).rejects.toThrow(
        'Budget not found'
      );
    });
  });

  describe('deleteBudget()', () => {
    it('should delete budget successfully', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.deleteBudget(budgetId);

      expect(result).toBe(true);
    });

    it('should throw error for non-existent budget', async () => {
      const nonExistentId = 'invalid-budget-id';

      await expect(budgetsService.deleteBudget(nonExistentId)).rejects.toThrow(
        'Budget not found'
      );
    });
  });

  describe('getBudgetStatus()', () => {
    it('should return budget status with spending', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.getBudgetStatus(budgetId);

      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('spent');
      expect(result).toHaveProperty('remaining');
      expect(result).toHaveProperty('percentage');
      expect(result.percentage).toBe((result.spent / result.limit) * 100);
    });

    it('should identify over-budget status', async () => {
      const budgetId = 'budget-over-budget';

      const result = await budgetsService.getBudgetStatus(budgetId);

      if (result.spent > result.limit) {
        expect(result.isOverBudget).toBe(true);
        expect(result.overAmount).toBe(result.spent - result.limit);
      }
    });

    it('should provide warning threshold', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.getBudgetStatus(budgetId);

      expect(result).toHaveProperty('warningLevel');
      expect(result).toHaveProperty('isWarning');
      if (result.percentage >= result.warningLevel) {
        expect(result.isWarning).toBe(true);
      }
    });
  });

  describe('getBudgetsByCategory()', () => {
    it('should retrieve budgets for specific category', async () => {
      const userId = 'user-123';
      const category = 'food';

      const result = await budgetsService.getBudgetsByCategory(userId, category);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((budget) => {
        expect(budget.category).toBe(category);
      });
    });
  });

  describe('trackBudgetSpending()', () => {
    it('should update budget spending from transactions', async () => {
      const budgetId = 'budget-123';
      const transaction = {
        id: 'txn-456',
        amount: 75.00,
        category: 'food',
        date: new Date(),
      };

      const result = await budgetsService.trackBudgetSpending(budgetId, transaction);

      expect(result).toBeDefined();
      expect(result.spent).toBeGreaterThan(0);
    });

    it('should not track if transaction outside budget period', async () => {
      const budgetId = 'budget-june';
      const transaction = {
        id: 'txn-456',
        amount: 75.00,
        category: 'food',
        date: new Date('2026-07-15'), // Outside June budget
      };

      await expect(
        budgetsService.trackBudgetSpending(budgetId, transaction)
      ).rejects.toThrow('Transaction outside budget period');
    });
  });

  describe('getBudgetAlerts()', () => {
    it('should return alerts for over-budget conditions', async () => {
      const userId = 'user-123';

      const result = await budgetsService.getBudgetAlerts(userId);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((alert) => {
        expect(alert).toHaveProperty('budgetId');
        expect(alert).toHaveProperty('message');
        expect(alert).toHaveProperty('severity'); // 'warning' or 'danger'
      });
    });

    it('should prioritize danger alerts', async () => {
      const userId = 'user-123';

      const result = await budgetsService.getBudgetAlerts(userId);

      if (result.length > 1) {
        const dangerAlerts = result.filter((a) => a.severity === 'danger');
        const warningAlerts = result.filter((a) => a.severity === 'warning');
        // Danger alerts should come first
        expect(result.indexOf(dangerAlerts[0])).toBeLessThan(
          result.indexOf(warningAlerts[0])
        );
      }
    });
  });

  describe('compareWithPreviousPeriod()', () => {
    it('should compare current budget with previous period', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.compareWithPreviousPeriod(budgetId);

      expect(result).toHaveProperty('currentSpent');
      expect(result).toHaveProperty('previousSpent');
      expect(result).toHaveProperty('difference');
      expect(result).toHaveProperty('percentageChange');
    });

    it('should identify spending trends', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.compareWithPreviousPeriod(budgetId);

      if (result.currentSpent > result.previousSpent) {
        expect(result.trend).toBe('increasing');
      } else if (result.currentSpent < result.previousSpent) {
        expect(result.trend).toBe('decreasing');
      } else {
        expect(result.trend).toBe('stable');
      }
    });
  });

  describe('getSuggestedBudgets()', () => {
    it('should suggest budgets based on transaction history', async () => {
      const userId = 'user-123';

      const result = await budgetsService.getSuggestedBudgets(userId);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((suggestion) => {
        expect(suggestion).toHaveProperty('category');
        expect(suggestion).toHaveProperty('suggestedLimit');
        expect(suggestion).toHaveProperty('averageSpending');
        expect(suggestion).toHaveProperty('confidence');
      });
    });

    it('should only suggest for categories with transaction history', async () => {
      const userId = 'user-123';

      const result = await budgetsService.getSuggestedBudgets(userId);

      result.forEach((suggestion) => {
        expect(suggestion.averageSpending).toBeGreaterThan(0);
      });
    });
  });

  describe('resetBudget()', () => {
    it('should reset budget spent amount for new period', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.resetBudget(budgetId);

      expect(result.spent).toBe(0);
      expect(result.remaining).toBe(result.limit);
    });

    it('should archive old budget and create new one', async () => {
      const budgetId = 'budget-123';

      const result = await budgetsService.resetBudget(budgetId, { archive: true });

      expect(result).toHaveProperty('newBudgetId');
      expect(result).toHaveProperty('archivedBudgetId');
    });
  });
});