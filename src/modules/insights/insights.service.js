const {
  calculateTopCategory,
  calculateSavingsRate,
} = require('./insights.utils');

function generateMonthlyInsights(report, breakdown) {
  const insights = [];

  const top = calculateTopCategory(breakdown);

  if (top) {
    insights.push({
      type: 'spending',
      message: `Highest spending: ${top.categoryName}`,
    });
  }

  const savingsRate = calculateSavingsRate(
    report.totalIncome,
    report.totalExpenses
  );

  insights.push({
    type: 'info',
    message: `Savings rate: ${savingsRate.toFixed(1)}%`,
  });

  if (report.totalExpenses > report.totalIncome) {
    insights.push({
      type: 'warning',
      message: 'Expenses exceeded income this month.',
    });
  }

  return insights;
}

module.exports = {
  generateMonthlyInsights,
};