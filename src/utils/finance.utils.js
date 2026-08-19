/**
 * @module finance/financial.utils
 * @description Core financial calculations, analytics, and AI logic engine
 */

const { logger } = require('../../config/logger.config');

// ═══════════════════════════════════════════════════════════════════════════
// 1. TRANSACTION ANALYSIS & AGGREGATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate total income for a period
 */
function calculateTotalIncome(transactions) {
  if (!Array.isArray(transactions)) return 0;
  return transactions
    .filter(t => t.type === 'income')
    .reduce((sum, t) => sum + Number(t.amount || t.amount_in_base_currency || 0), 0);
}

/**
 * Calculate total expenses for a period
 */
function calculateTotalExpenses(transactions) {
  if (!Array.isArray(transactions)) return 0;
  return transactions
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + Number(t.amount || t.amount_in_base_currency || 0), 0);
}

/**
 * Calculate net income (income - expenses)
 */
function calculateNetIncome(transactions) {
  const income = calculateTotalIncome(transactions);
  const expenses = calculateTotalExpenses(transactions);
  return income - expenses;
}

/**
 * Calculate savings rate (percentage of income saved)
 */
function calculateSavingsRate(transactions) {
  const income = calculateTotalIncome(transactions);
  if (income === 0) return 0;
  const netIncome = calculateNetIncome(transactions);
  return ((netIncome / income) * 100).toFixed(2);
}

/**
 * Calculate average transaction amount
 */
function calculateAverageTransaction(transactions, type = null) {
  let filtered = transactions;
  if (type) {
    filtered = transactions.filter(t => t.type === type);
  }
  
  if (filtered.length === 0) return 0;
  const total = filtered.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  return (total / filtered.length).toFixed(2);
}

/**
 * Find largest transaction
 */
function findLargestTransaction(transactions, type = null) {
  let filtered = transactions;
  if (type) {
    filtered = transactions.filter(t => t.type === type);
  }
  
  if (filtered.length === 0) return null;
  return filtered.reduce((max, t) => {
    const amount = Number(t.amount || 0);
    return amount > Number(max.amount || 0) ? t : max;
  });
}

/**
 * Find smallest transaction
 */
function findSmallestTransaction(transactions, type = null) {
  let filtered = transactions;
  if (type) {
    filtered = transactions.filter(t => t.type === type);
  }
  
  if (filtered.length === 0) return null;
  return filtered.reduce((min, t) => {
    const amount = Number(t.amount || 0);
    return amount < Number(min.amount || 0) ? t : min;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. CATEGORY ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Breakdown expenses by category
 */
function analyzeByCategory(transactions) {
  const categoryMap = {};
  
  transactions
    .filter(t => t.type === 'expense')
    .forEach(t => {
      const category = t.category || 'Uncategorized';
      const amount = Number(t.amount || 0);
      
      if (!categoryMap[category]) {
        categoryMap[category] = { total: 0, count: 0, percentage: 0 };
      }
      categoryMap[category].total += amount;
      categoryMap[category].count += 1;
    });

  const totalExpenses = calculateTotalExpenses(transactions);
  
  // Add percentage and sort by total descending
  const result = Object.entries(categoryMap)
    .map(([category, data]) => ({
      category,
      total: data.total.toFixed(2),
      count: data.count,
      percentage: totalExpenses > 0 
        ? ((data.total / totalExpenses) * 100).toFixed(2)
        : 0,
      average: (data.total / data.count).toFixed(2),
    }))
    .sort((a, b) => Number(b.total) - Number(a.total));

  return result;
}

/**
 * Get top spending categories
 */
function getTopCategories(transactions, limit = 5) {
  return analyzeByCategory(transactions).slice(0, limit);
}

/**
 * Get income sources breakdown
 */
function analyzeIncomeBySource(transactions) {
  const sourceMap = {};
  
  transactions
    .filter(t => t.type === 'income')
    .forEach(t => {
      const source = t.category || 'Other';
      const amount = Number(t.amount || 0);
      
      if (!sourceMap[source]) {
        sourceMap[source] = { total: 0, count: 0 };
      }
      sourceMap[source].total += amount;
      sourceMap[source].count += 1;
    });

  const totalIncome = calculateTotalIncome(transactions);

  return Object.entries(sourceMap)
    .map(([source, data]) => ({
      source,
      total: data.total.toFixed(2),
      count: data.count,
      percentage: totalIncome > 0
        ? ((data.total / totalIncome) * 100).toFixed(2)
        : 0,
    }))
    .sort((a, b) => Number(b.total) - Number(a.total));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SPENDING PATTERNS & TRENDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyze spending trends (increasing/decreasing)
 */
function analyzeSpendingTrends(transactions, periods = 3) {
  if (!Array.isArray(transactions) || transactions.length < 2) {
    return { trend: 'insufficient_data', direction: null };
  }

  // Sort by date
  const sorted = [...transactions].sort((a, b) => 
    new Date(a.date || a.created_at) - new Date(b.date || b.created_at)
  );

  // Divide into periods
  const periodSize = Math.ceil(sorted.length / periods);
  const periodExpenses = [];

  for (let i = 0; i < periods; i++) {
    const start = i * periodSize;
    const end = Math.min((i + 1) * periodSize, sorted.length);
    const periodTxns = sorted.slice(start, end);
    const total = calculateTotalExpenses(periodTxns);
    periodExpenses.push(total);
  }

  // Calculate trend
  let trend = 'stable';
  let direction = null;

  if (periodExpenses.length >= 2) {
    const firstAvg = periodExpenses.slice(0, Math.ceil(periods / 2))
      .reduce((a, b) => a + b, 0) / Math.ceil(periods / 2);
    
    const lastAvg = periodExpenses.slice(Math.ceil(periods / 2))
      .reduce((a, b) => a + b, 0) / (periods - Math.ceil(periods / 2));

    const percentChange = ((lastAvg - firstAvg) / firstAvg) * 100;

    if (percentChange > 10) {
      trend = 'increasing';
      direction = 'up';
    } else if (percentChange < -10) {
      trend = 'decreasing';
      direction = 'down';
    }
  }

  return {
    trend,
    direction,
    periodExpenses,
    percentChange: ((periodExpenses[periodExpenses.length - 1] - periodExpenses[0]) / periodExpenses[0] * 100).toFixed(2),
  };
}

/**
 * Identify unusual spending (outliers)
 */
function identifyAnomalies(transactions, threshold = 2) {
  const expenses = transactions
    .filter(t => t.type === 'expense')
    .map(t => Number(t.amount || 0));

  if (expenses.length < 2) return [];

  // Calculate mean and standard deviation
  const mean = expenses.reduce((a, b) => a + b, 0) / expenses.length;
  const variance = expenses.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / expenses.length;
  const stdDev = Math.sqrt(variance);

  // Find anomalies (more than threshold * stdDev from mean)
  return transactions
    .filter(t => t.type === 'expense')
    .filter(t => Math.abs(Number(t.amount || 0) - mean) > threshold * stdDev)
    .map(t => ({
      ...t,
      anomalyScore: ((Math.abs(Number(t.amount || 0) - mean) / stdDev).toFixed(2)),
      reason: Number(t.amount || 0) > mean ? 'unusually_high' : 'unusually_low',
    }))
    .sort((a, b) => Number(b.anomalyScore) - Number(a.anomalyScore));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. BUDGET ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare actual spending vs budget
 */
function analyzeBudgetPerformance(transactions, budgets) {
  if (!Array.isArray(budgets) || budgets.length === 0) {
    return [];
  }

  const categoryExpenses = {};
  
  transactions
    .filter(t => t.type === 'expense')
    .forEach(t => {
      const category = t.category || 'Uncategorized';
      const amount = Number(t.amount || 0);
      categoryExpenses[category] = (categoryExpenses[category] || 0) + amount;
    });

  return budgets.map(budget => {
    const category = budget.category || budget.name;
    const spent = categoryExpenses[category] || 0;
    const limit = Number(budget.amount || budget.amountLimit || 0);
    const remaining = limit - spent;
    const percentage = limit > 0 ? ((spent / limit) * 100).toFixed(2) : 0;

    return {
      category,
      limit: limit.toFixed(2),
      spent: spent.toFixed(2),
      remaining: remaining.toFixed(2),
      percentage: Number(percentage),
      status: percentage > 100 ? 'exceeded' : percentage > 80 ? 'warning' : 'ok',
      recommendation: 
        percentage > 100 ? `You've exceeded the budget for ${category} by $${Math.abs(remaining).toFixed(2)}` :
        percentage > 80 ? `You're approaching the budget limit for ${category}` :
        `You have $${remaining.toFixed(2)} remaining in ${category} budget`,
    };
  });
}

/**
 * Calculate ideal budget allocation (50/30/20 rule)
 */
function suggestIdealBudget(transactions) {
  const income = calculateTotalIncome(transactions);
  
  if (income === 0) {
    return { message: 'Insufficient income data to suggest budgets' };
  }

  const needs = income * 0.5;      // 50% for needs
  const wants = income * 0.3;      // 30% for wants
  const savings = income * 0.2;    // 20% for savings

  // Analyze current spending
  const categories = analyzeByCategory(transactions);

  return {
    monthlyIncome: income.toFixed(2),
    suggested: {
      needs: {
        amount: needs.toFixed(2),
        percentage: '50%',
        categories: ['Groceries', 'Utilities', 'Rent', 'Insurance', 'Transportation'],
      },
      wants: {
        amount: wants.toFixed(2),
        percentage: '30%',
        categories: ['Entertainment', 'Dining', 'Shopping', 'Hobbies', 'Travel'],
      },
      savings: {
        amount: savings.toFixed(2),
        percentage: '20%',
        categories: ['Emergency Fund', 'Investments', 'Retirement', 'Goals'],
      },
    },
    actualSpending: {
      topCategories: categories.slice(0, 5),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. FINANCIAL HEALTH SCORING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate financial health score (0-100)
 */
function calculateFinancialScore(transactions, budgets) {
  let score = 0;
  const factors = {};

  // Factor 1: Savings Rate (0-25 points)
  const savingsRate = Number(calculateSavingsRate(transactions));
  if (savingsRate >= 20) factors.savingsRate = 25;
  else if (savingsRate >= 15) factors.savingsRate = 20;
  else if (savingsRate >= 10) factors.savingsRate = 15;
  else if (savingsRate >= 5) factors.savingsRate = 10;
  else if (savingsRate >= 0) factors.savingsRate = 5;
  else factors.savingsRate = 0;

  // Factor 2: Budget Adherence (0-25 points)
  if (Array.isArray(budgets) && budgets.length > 0) {
    const performance = analyzeBudgetPerformance(transactions, budgets);
    const goodBudgets = performance.filter(p => p.status === 'ok').length;
    factors.budgetAdherence = (goodBudgets / performance.length) * 25;
  } else {
    factors.budgetAdherence = 0;
  }

  // Factor 3: Spending Stability (0-20 points)
  const trends = analyzeSpendingTrends(transactions);
  if (trends.trend === 'stable') factors.stability = 20;
  else if (trends.trend === 'decreasing') factors.stability = 15;
  else factors.stability = 5;

  // Factor 4: No Anomalies (0-15 points)
  const anomalies = identifyAnomalies(transactions);
  if (anomalies.length === 0) factors.anomalies = 15;
  else if (anomalies.length <= 2) factors.anomalies = 10;
  else if (anomalies.length <= 5) factors.anomalies = 5;
  else factors.anomalies = 0;

  // Factor 5: Income Consistency (0-15 points)
  const incomes = transactions.filter(t => t.type === 'income');
  if (incomes.length > 0) {
    const incomeAmounts = incomes.map(t => Number(t.amount || 0));
    const incomeVariance = calculateVariance(incomeAmounts);
    const incomeStdDev = Math.sqrt(incomeVariance);
    const incomeAvg = incomeAmounts.reduce((a, b) => a + b, 0) / incomeAmounts.length;
    const incomeCV = incomeAvg > 0 ? (incomeStdDev / incomeAvg) : 0;

    if (incomeCV < 0.1) factors.incomeConsistency = 15;
    else if (incomeCV < 0.2) factors.incomeConsistency = 10;
    else if (incomeCV < 0.3) factors.incomeConsistency = 5;
    else factors.incomeConsistency = 0;
  } else {
    factors.incomeConsistency = 0;
  }

  score = Object.values(factors).reduce((a, b) => a + b, 0);

  return {
    score: Math.min(100, Math.max(0, Math.round(score))),
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
    factors,
    analysis: generateScoreAnalysis(score, factors),
  };
}

/**
 * Generate analysis text based on score
 */
function generateScoreAnalysis(score, factors) {
  if (score >= 90) return 'Excellent financial health! You\'re managing your money very well.';
  if (score >= 80) return 'Good financial health. Small improvements could boost your score further.';
  if (score >= 70) return 'Fair financial health. Focus on savings and budget adherence.';
  if (score >= 60) return 'Needs improvement. Consider tracking spending and setting budgets.';
  return 'Poor financial health. Start by tracking expenses and creating a budget.';
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. GOAL TRACKING & PROJECTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate time to reach financial goal
 */
function calculateTimeToGoal(currentAmount, goalAmount, monthlyContribution) {
  if (monthlyContribution <= 0) {
    return { months: Infinity, years: Infinity, message: 'Goal unreachable with current contribution' };
  }

  const needed = goalAmount - currentAmount;
  const months = Math.ceil(needed / monthlyContribution);
  const years = (months / 12).toFixed(1);

  return {
    months,
    years,
    message: `At $${monthlyContribution}/month, you'll reach $${goalAmount} in ${months} months (${years} years)`,
    milestone: {
      current: currentAmount.toFixed(2),
      goal: goalAmount.toFixed(2),
      remaining: Math.max(0, needed).toFixed(2),
      progress: ((currentAmount / goalAmount) * 100).toFixed(2),
    },
  };
}

/**
 * Project savings based on current rate
 */
function projectSavings(transactions, months = 12) {
  const monthlyAverage = calculateNetIncome(transactions);
  const projection = [];

  for (let i = 1; i <= months; i++) {
    projection.push({
      month: i,
      projected: (monthlyAverage * i).toFixed(2),
    });
  }

  return {
    monthlyAverageSavings: monthlyAverage.toFixed(2),
    projectedSavingsIn12Months: (monthlyAverage * months).toFixed(2),
    projection,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. RECOMMENDATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate AI recommendations
 */
function generateRecommendations(transactions, budgets) {
  const recommendations = [];
  const score = calculateFinancialScore(transactions, budgets);
  const categories = analyzeByCategory(transactions);
  const trends = analyzeSpendingTrends(transactions);
  const savingsRate = Number(calculateSavingsRate(transactions));
  const anomalies = identifyAnomalies(transactions);
  const budgetPerf = analyzeBudgetPerformance(transactions, budgets);

  // Recommendation 1: Savings rate
  if (savingsRate < 10) {
    recommendations.push({
      id: 'savings_rate_low',
      priority: 'high',
      category: 'savings',
      title: 'Increase Your Savings Rate',
      description: `Your current savings rate is ${savingsRate}%. Aim for at least 10-20%.`,
      actionItems: [
        'Review discretionary spending in top categories',
        'Consider cutting back on wants (dining, entertainment)',
        'Automate transfers to savings account',
      ],
      estimatedImpact: `Could save an additional $${(calculateTotalIncome(transactions) * 0.1).toFixed(2)}/month`,
    });
  }

  // Recommendation 2: Top spending category
  if (categories.length > 0 && Number(categories[0].percentage) > 40) {
    recommendations.push({
      id: 'high_category_spending',
      priority: 'medium',
      category: 'spending',
      title: `Reduce ${categories[0].category} Spending`,
      description: `${categories[0].category} accounts for ${categories[0].percentage}% of your expenses.`,
      actionItems: [
        `Review your ${categories[0].category} transactions for patterns`,
        `Identify non-essential spending in this category`,
        `Set a realistic budget for ${categories[0].category}`,
      ],
      currentSpending: categories[0].total,
      suggestedCut: (Number(categories[0].total) * 0.1).toFixed(2),
    });
  }

  // Recommendation 3: Budget overspending
  if (budgetPerf.some(b => b.status === 'exceeded')) {
    const exceeded = budgetPerf.filter(b => b.status === 'exceeded');
    recommendations.push({
      id: 'budget_exceeded',
      priority: 'high',
      category: 'budget',
      title: 'Budget Overruns Detected',
      description: `${exceeded.length} budget(s) exceeded this period.`,
      overrunDetails: exceeded.map(b => ({
        category: b.category,
        amount: b.remaining,
      })),
      actionItems: [
        'Review excessive spending categories',
        'Identify one-time vs recurring overspends',
        'Adjust future budgets accordingly',
      ],
    });
  }

  // Recommendation 4: Spending anomalies
  if (anomalies.length > 0) {
    recommendations.push({
      id: 'spending_anomalies',
      priority: 'medium',
      category: 'analysis',
      title: 'Unusual Spending Detected',
      description: `Found ${anomalies.length} unusual transaction(s).`,
      anomalies: anomalies.slice(0, 3),
      actionItems: [
        'Review flagged transactions for accuracy',
        'Check for fraud or duplicate charges',
        'Consider excluding one-time expenses from analysis',
      ],
    });
  }

  // Recommendation 5: Spending trend
  if (trends.direction === 'up') {
    recommendations.push({
      id: 'spending_increasing',
      priority: 'medium',
      category: 'trends',
      title: 'Spending Trend Increasing',
      description: `Your expenses have increased by ${trends.percentChange}% recently.`,
      actionItems: [
        'Identify what categories are driving the increase',
        'Determine if it\'s temporary or a new pattern',
        'Create action plan to stabilize spending',
      ],
      percentChange: trends.percentChange,
    });
  }

  // Recommendation 6: Emergency fund
  const netIncome = calculateNetIncome(transactions);
  if (netIncome > 0) {
    const recommendedEmergency = calculateTotalExpenses(transactions) * 3;
    recommendations.push({
      id: 'emergency_fund',
      priority: 'high',
      category: 'savings',
      title: 'Build Emergency Fund',
      description: `Recommended: 3-6 months of expenses ($${recommendedEmergency.toFixed(2)})`,
      actionItems: [
        'Set up separate savings account',
        `Auto-transfer $${(netIncome * 0.5).toFixed(2)}/month to emergency fund`,
        'Keep funds liquid but separate from checking',
      ],
      recommendedAmount: recommendedEmergency.toFixed(2),
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recommendations;
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. HELPER UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate variance
 */
function calculateVariance(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
}

/**
 * Format currency
 */
function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

/**
 * Calculate compound interest
 */
function calculateCompoundInterest(principal, rate, time, compounds = 12) {
  const rateDecimal = rate / 100;
  return principal * Math.pow(1 + rateDecimal / compounds, compounds * time);
}

/**
 * Calculate loan payment (monthly)
 */
function calculateLoanPayment(principal, annualRate, months) {
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return (principal / months).toFixed(2);
  
  return (
    (principal * (monthlyRate * Math.pow(1 + monthlyRate, months))) /
    (Math.pow(1 + monthlyRate, months) - 1)
  ).toFixed(2);
}

/**
 * Calculate debt payoff timeline
 */
function calculateDebtPayoff(debt, monthlyPayment, annualRate) {
  const monthlyRate = annualRate / 100 / 12;
  let remaining = debt;
  let months = 0;
  const maxMonths = 30 * 12; // 30 years max

  while (remaining > 0 && months < maxMonths) {
    remaining = remaining * (1 + monthlyRate) - monthlyPayment;
    months++;
  }

  return {
    months,
    years: (months / 12).toFixed(1),
    payoffDate: new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toLocaleDateString(),
    totalInterest: (monthlyPayment * months - debt).toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. MONTHLY INSIGHTS GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate comprehensive monthly insights
 */
function generateMonthlyInsights(transactions, budgets, previousMonth = null) {
  const currentScore = calculateFinancialScore(transactions, budgets);
  const recommendations = generateRecommendations(transactions, budgets);
  const categories = analyzeByCategory(transactions);
  const trends = analyzeSpendingTrends(transactions);
  const anomalies = identifyAnomalies(transactions);
  const incomeBreakdown = analyzeIncomeBySource(transactions);

  let scoreChange = null;
  if (previousMonth) {
    const previousScore = calculateFinancialScore(previousMonth.transactions, previousMonth.budgets);
    scoreChange = currentScore.score - previousScore.score;
  }

  return {
    period: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    summary: {
      totalIncome: calculateTotalIncome(transactions).toFixed(2),
      totalExpenses: calculateTotalExpenses(transactions).toFixed(2),
      netIncome: calculateNetIncome(transactions).toFixed(2),
      savingsRate: calculateSavingsRate(transactions),
    },
    financialScore: {
      current: currentScore.score,
      change: scoreChange,
      grade: currentScore.grade,
      analysis: currentScore.analysis,
    },
    topCategories: categories.slice(0, 5),
    incomeBreakdown,
    trends: {
      spending: trends.trend,
      direction: trends.direction,
      percentChange: trends.percentChange,
    },
    alerts: {
      anomalies: anomalies.length,
      budgetExceeded: analyzeBudgetPerformance(transactions, budgets)
        .filter(b => b.status === 'exceeded').length,
    },
    recommendations: recommendations.slice(0, 5),
    insights: generateTextInsights(transactions, currentScore, trends, anomalies),
  };
}

/**
 * Generate AI-style text insights
 */
function generateTextInsights(transactions, score, trends, anomalies) {
  const insights = [];

  // Insight 1
  insights.push(
    score.score >= 80
      ? `Great job! Your financial score of ${score.score} shows strong money management.`
      : `Your financial score is ${score.score}. Focus on the recommendations to improve.`
  );

  // Insight 2
  if (trends.direction === 'down') {
    insights.push(`Positive trend: Your spending decreased by ${Math.abs(trends.percentChange)}% compared to last period.`);
  } else if (trends.direction === 'up') {
    insights.push(`Watch out: Your spending increased by ${trends.percentChange}% compared to last period.`);
  }

  // Insight 3
  if (anomalies.length > 0) {
    insights.push(`Detected ${anomalies.length} unusual transaction(s). Review them to ensure accuracy.`);
  }

  // Insight 4
  const savingsRate = Number(calculateSavingsRate(transactions));
  if (savingsRate >= 20) {
    insights.push(`Excellent savings rate of ${savingsRate}%! You\'re building wealth effectively.`);
  } else if (savingsRate > 0) {
    insights.push(`You\'re saving ${savingsRate}% of income. Consider increasing this to 20%+.`);
  }

  return insights;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Basic calculations
  calculateTotalIncome,
  calculateTotalExpenses,
  calculateNetIncome,
  calculateSavingsRate,
  calculateAverageTransaction,
  findLargestTransaction,
  findSmallestTransaction,

  // Category analysis
  analyzeByCategory,
  getTopCategories,
  analyzeIncomeBySource,

  // Trends & patterns
  analyzeSpendingTrends,
  identifyAnomalies,

  // Budget
  analyzeBudgetPerformance,
  suggestIdealBudget,

  // Health & scoring
  calculateFinancialScore,
  generateScoreAnalysis,

  // Goals & projections
  calculateTimeToGoal,
  projectSavings,

  // Recommendations
  generateRecommendations,

  // Utilities
  calculateVariance,
  formatCurrency,
  calculateCompoundInterest,
  calculateLoanPayment,
  calculateDebtPayoff,

  // Insights
  generateMonthlyInsights,
  generateTextInsights,
};