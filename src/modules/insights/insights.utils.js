function calculateTopCategory(breakdown) {
  return breakdown.reduce((max, item) =>
    item.total > (max?.total || 0) ? item : max,
    null
  );
}

function calculateSavingsRate(income, expenses) {
  if (!income) return 0;
  return ((income - expenses) / income) * 100;
}

module.exports = {
  calculateTopCategory,
  calculateSavingsRate,
};