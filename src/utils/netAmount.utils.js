function calculateNetAmount(transactions = []) {
  return transactions.reduce((sum, tx) => {
    const amount = Number(tx.amountInBaseCurrency || 0);

    if (tx.type === 'income') return sum + amount;
    if (tx.type === 'expense') return sum - amount;

    return sum;
  }, 0);
}

module.exports = { 
    calculateNetAmount
};