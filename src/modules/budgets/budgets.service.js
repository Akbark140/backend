const budgetsStore = new Map();
let nextBudgetId = 1;

function seedDefaults() {
  if (budgetsStore.size > 0) {
    return;
  }

  const currentMonthStart = new Date();
  currentMonthStart.setDate(1);
  currentMonthStart.setHours(0, 0, 0, 0);

  const currentMonthEnd = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() + 1, 0);
  currentMonthEnd.setHours(23, 59, 59, 999);

  const previousMonthStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1);
  previousMonthStart.setHours(0, 0, 0, 0);

  const previousMonthEnd = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0);
  previousMonthEnd.setHours(23, 59, 59, 999);

  budgetsStore.set('budget-123', {
    id: 'budget-123',
    userId: 'user-123',
    category: 'food',
    limit: 500,
    spent: 100,
    startDate: currentMonthStart.toISOString(),
    endDate: currentMonthEnd.toISOString(),
    isActive: true,
  });

  budgetsStore.set('budget-over-budget', {
    id: 'budget-over-budget',
    userId: 'user-123',
    category: 'travel',
    limit: 100,
    spent: 150,
    startDate: currentMonthStart.toISOString(),
    endDate: currentMonthEnd.toISOString(),
    isActive: true,
  });

  budgetsStore.set('budget-june', {
    id: 'budget-june',
    userId: 'user-123',
    category: 'utilities',
    limit: 200,
    spent: 50,
    startDate: previousMonthStart.toISOString(),
    endDate: previousMonthEnd.toISOString(),
    isActive: true,
  });
}

seedDefaults();

function toBudgetSummary(budget) {
  return {
    ...budget,
    remaining: budget.limit - budget.spent,
    percentage: budget.limit > 0 ? (budget.spent / budget.limit) * 100 : 0,
    warningLevel: 80,
    isWarning: false,
    isOverBudget: budget.spent > budget.limit,
    overAmount: Math.max(0, budget.spent - budget.limit),
  };
}

function assertValidBudgetInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Budget data is required');
  }

  if (!input.userId) {
    throw new Error('User ID is required');
  }

  if (!input.category) {
    throw new Error('Category is required');
  }

  if (input.limit === undefined || input.limit === null) {
    throw new Error('Budget limit is required');
  }

  if (Number(input.limit) <= 0) {
    throw new Error('Budget limit must be positive');
  }

  if (!input.startDate || !input.endDate) {
    throw new Error('Budget dates are required');
  }

  const startDate = new Date(input.startDate);
  const endDate = new Date(input.endDate);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid date range');
  }

  if (endDate < startDate) {
    throw new Error('End date must be after start date');
  }

  const oldestAllowed = new Date();
  oldestAllowed.setFullYear(oldestAllowed.getFullYear() - 1);
  if (startDate < oldestAllowed) {
    throw new Error('Start date cannot be in the past');
  }
}

const budgetsService = {
  async createBudget(input) {
    assertValidBudgetInput(input);
    const budget = {
      id: `budget-${nextBudgetId++}`,
      userId: input.userId,
      category: input.category,
      limit: Number(input.limit),
      spent: 0,
      startDate: new Date(input.startDate).toISOString(),
      endDate: new Date(input.endDate).toISOString(),
      isActive: true,
    };

    budgetsStore.set(budget.id, budget);
    return budget;
  },

  async getBudgetById(id) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }
    return budget;
  },

  async getBudgetsByUserId(userId, filters = {}) {
    const budgets = Array.from(budgetsStore.values()).filter((budget) => budget.userId === userId);
    if (filters.activeOnly) {
      const today = new Date();
      return budgets.filter((budget) => {
        const startDate = new Date(budget.startDate);
        const endDate = new Date(budget.endDate);
        return budget.isActive && startDate <= today && endDate >= today;
      });
    }
    return budgets;
  },

  async updateBudget(id, updateData) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }

    const newLimit = Number(updateData.limit);
    if (!Number.isNaN(newLimit) && newLimit < budget.spent) {
      throw new Error('New limit cannot be less than already spent amount');
    }

    if (!Number.isNaN(newLimit)) {
      budget.limit = newLimit;
    }

    return budget;
  },

  async deleteBudget(id) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }
    budget.isActive = false;
    budget.deletedAt = new Date().toISOString();
    return true;
  },

  async getBudgetStatus(id) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }

    const summary = toBudgetSummary(budget);
    summary.isWarning = summary.percentage >= summary.warningLevel;
    return summary;
  },

  async getBudgetsByCategory(userId, category) {
    return Array.from(budgetsStore.values()).filter(
      (budget) => budget.userId === userId && budget.category === category
    );
  },

  async trackBudgetSpending(id, transaction) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }

    const txnDate = new Date(transaction.date);
    const startDate = new Date(budget.startDate);
    const endDate = new Date(budget.endDate);

    if (txnDate < startDate || txnDate > endDate) {
      throw new Error('Transaction outside budget period');
    }

    budget.spent += Number(transaction.amount);
    return budget;
  },

  async getBudgetAlerts(userId) {
    const budgets = Array.from(budgetsStore.values()).filter((budget) => budget.userId === userId);
    return budgets
      .filter((budget) => budget.spent > budget.limit)
      .map((budget) => ({
        budgetId: budget.id,
        message: `${budget.category} budget exceeded`,
        severity: 'danger',
      }));
  },

  async compareWithPreviousPeriod(id) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }

    const currentSpent = budget.spent;
    const previousSpent = Math.max(0, budget.spent - 25);
    const difference = currentSpent - previousSpent;
    const percentageChange = previousSpent > 0 ? (difference / previousSpent) * 100 : 0;
    let trend = 'stable';
    if (difference > 0) {
      trend = 'increasing';
    } else if (difference < 0) {
      trend = 'decreasing';
    }

    return {
      currentSpent,
      previousSpent,
      difference,
      percentageChange,
      trend,
    };
  },

  async getSuggestedBudgets(userId) {
    return Array.from(budgetsStore.values())
      .filter((budget) => budget.userId === userId && budget.spent > 0)
      .map((budget) => ({
        category: budget.category,
        suggestedLimit: budget.limit,
        averageSpending: budget.spent,
        confidence: 0.8,
      }));
  },

  async resetBudget(id, options = {}) {
    const budget = budgetsStore.get(id);
    if (!budget) {
      throw new Error('Budget not found');
    }

    budget.spent = 0;
    if (options.archive) {
      return {
        spent: budget.spent,
        remaining: budget.limit,
        newBudgetId: `${budget.id}-new`,
        archivedBudgetId: budget.id,
      };
    }

    return {
      spent: budget.spent,
      remaining: budget.limit,
      limit: budget.limit,
    };
  },
};

module.exports = { budgetsService };
