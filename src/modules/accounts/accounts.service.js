// src/modules/accounts/accounts.service.js

const repo = require('./accounts.repository');
const { logger } = require('../../config/logger.config');
const currencyService = require('../currencies/currencies.service');

async function validateOwnership(accountId, userId) {
  const isOwner = await repo.verifyOwnership(accountId, userId);
  if (!isOwner) {
    const error = new Error("Access Denied: Account resource does not exist or ownership validation failed.");
    error.status = 403;
    throw error;
  }
  return true;
}

async function getExchangeRate(fromCurrency, toCurrency) {
  try {
    // Assuming you have a rates table or repository configuration
    const rateRow = await repo.getExchangeRate({ fromCurrency, toCurrency });
    if (!rateRow) {
      throw new Error(`No conversion pathway found from ${fromCurrency} to ${toCurrency}.`);
    }
    return Number(rateRow.rate);
  } catch (error) {
    logger.error(`[EXCHANGE_RATE_FETCH_FAILURE]: ${error.message}`);
    throw new Error('Currency conversion services are currently unavailable.');
  }
}

async function createAccount(userId, accountData) {
  try {
    const coreList = await repo.findAllByUser(userId);

    // Core Business Rule: Check for naming collisions within user context
    const isDuplicate = coreList.some(acc => acc.name.toLowerCase() === accountData.name.toLowerCase());
    if (isDuplicate) {
      const error = new Error(`An account with the name "${accountData.name}" already exists.`);
      error.status = 400;
      throw error;
    }

    // Rule: First account auto-defaults to standard baseline
    const isFirstAccount = coreList.length === 0;
    return await repo.createAccount(userId, accountData, isFirstAccount);
  } catch (error) {
    logger.error(`[ACCOUNTS_SERVICE_CREATE_FAILURE]: ${error.message}`);
    throw error;
  }
}

/**
 * Fetches all accounts for a specific user and ensures safe array parsing
 * @param {string} userId - The unique UUID of the logged-in user
 */
async function getAccountsByUser(userId) {
  try {
    const accounts = await repo.findAllByUser(userId);
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    if (logger && typeof logger.error === 'function') {
      logger.error(`[ACCOUNTS_SERVICE_FIND_ALL_ERROR]: ${error.message}`);
    }
    throw error;
  }
}

async function updateAccount({ accountId, userId, updateData }) {

  // 1. DESTRUCTURE the variables here so they are passed as two separate parameters!
  await validateOwnership(accountId, userId);

  // 2. Forward them perfectly mapped to your updated object-based repository
  return await repo.updateAccount({
    accountId,
    userId,
    data: updateData
  });
}

async function archiveAccount({ accountId, userId }) {
  // 1. Destructure and validate ownership safely (prevents the NaN / object bug)
  await validateOwnership(accountId, userId);

  // 2. Re-use your updated repository function to patch the data
  return await repo.updateAccount({
    accountId,
    userId,
    data: { type: 'ARCHIVED' } // Or status: 'ARCHIVED' depending on your DB layout
  });
}

async function restoreAccount({ accountId, userId }) {
  // 1.Explicit destructuring prevents the object-to-NaN error!
  // Note: If you have a separate ownership bypass check for soft-deleted accounts, use that here.

  // 2. Clear out the deleted_at flag by reusing our secure repository update
  return await repo.updateAccount({
    accountId,
    userId,
    data: {
      // This resets your soft-delete state back to zero
      deleted_at: null
    }
  });
}

async function setDefaultAccount({ accountId, userId }) {
  await validateOwnership(accountId, userId); // CORRECT: Passing individual strings/integers

  await repo.clearDefaultFlag(userId);
  return await repo.updateAccount({
    accountId,
    userId,
    data: { is_default: true }
  });
}

async function deposit(accountId, userId, amount) {
  await validateOwnership(accountId, userId);
  const account = await repo.findById(accountId);
  if (account.status !== 'ACTIVE') throw new Error('Cannot deposit funds into an inactive account.');

  return await repo.mutateBalanceAtomically(accountId, Math.abs(amount));
}

async function withdraw(accountId, userId, amount) {
  await validateOwnership(accountId, userId);
  const account = await repo.findById(accountId);
  if (account.status !== 'ACTIVE') throw new Error('Cannot withdraw funds from an inactive account.');

  // Note: For loans/credit cards, balance represents current debt.
  if (account.type !== 'CREDIT_CARD' && account.type !== 'LOAN') {
    if (Number(account.balance) < amount) {
      throw new Error('Transaction Rejected: Insufficient available funds.');
    }
  }
  return await repo.mutateBalanceAtomically(accountId, -Math.abs(amount));
}

async function transferFunds(sourceId, targetId, userId, amount) {
  await validateOwnership(sourceId, userId);
  await validateOwnership(targetId, userId);

  if (Number(sourceId) === Number(targetId)) {
    throw new Error('Source and target endpoints must be distinct account containers.');
  }

  // 1. Fetch both account profiles to access their currency properties
  const sourceAccount = await repo.findById(sourceId);
  const targetAccount = await repo.findById(targetId);

  if (!sourceAccount || !targetAccount) {
    throw new Error('Transaction Rejected: One or both transaction endpoints could not be found.');
  }

  // 2. Default target amount to the base transfer amount
  let finalTargetAmount = amount;

  // 3. Check for currency mismatch (e.g., USD to PKR)
  if (sourceAccount.currency !== targetAccount.currency) {


    // Seamlessly handles checking local cache OR updating via the API behind the scenes
    const exchangeRate = await currencyService.getExchangeRate(sourceAccount.currency, targetAccount.currency);
    finalTargetAmount = amount * exchangeRate;

    logger.info(`[TRANSFER_EXCHANGE]: Converted ${amount} ${sourceAccount.currency} to ${finalTargetAmount} ${targetAccount.currency} using rate: ${exchangeRate}`);
  }

  // 4. Execute atomic operations using the distinct values
  await withdraw(sourceId, userId, amount);
  const targetUpdated = await deposit(targetId, userId, finalTargetAmount);

  return targetUpdated;
}

function calculateAvailableCredit(creditLimit, balanceOwed) {
  return Math.max(0, Number(creditLimit) - Number(balanceOwed));
}

function getCreditUtilization(creditLimit, balanceOwed) {
  if (Number(creditLimit) <= 0) return 0;
  return Number(((Number(balanceOwed) / Number(creditLimit)) * 100).toFixed(2));
}

async function calculateNetWorth(userId) {
  const assets = await repo.getTotalAssets(userId);
  const liabilities = await repo.getTotalLiabilities(userId);
  return {
    totalAssets: assets,
    totalLiabilities: liabilities,
    netWorth: assets - liabilities
  };
}

async function getDashboardMetrics(userId) {
  const accounts = await repo.findAllByUser(userId);
  const { totalAssets, totalLiabilities, netWorth } = await calculateNetWorth(userId);

  return {
    netWorth,
    totalAssets,
    totalLiabilities,
    accountCount: accounts.filter(a => a.status === 'ACTIVE').length
  };
}

async function buildAIContext(userId) {
  const accounts = await repo.findAllByUser(userId);
  const { totalAssets, totalLiabilities, netWorth } = await calculateNetWorth(userId);

  let cashBalance = 0;
  let bankBalance = 0;
  let creditDebt = 0;
  let aggregateCreditLimit = 0;

  accounts.forEach(acc => {
    if (acc.status === 'ACTIVE') {
      const bal = Number(acc.balance);
      if (acc.type === 'CASH') cashBalance += bal;
      if (acc.type === 'BANK' || acc.type === 'SAVINGS') bankBalance += bal;
      if (acc.type === 'CREDIT_CARD') {
        creditDebt += bal;
        aggregateCreditLimit += Number(acc.credit_limit);
      }
      if (acc.type === 'LOAN') creditDebt += bal;
    }
  });

  return {
    netWorth,
    cashBalance,
    bankBalance,
    creditDebt,
    creditUtilization: getCreditUtilization(aggregateCreditLimit, creditDebt),
    activeAccountsCount: accounts.filter(a => a.status === 'ACTIVE').length
  };
}

async function canDeleteAccount(accountId, userId) {
  await validateOwnership(accountId, userId);

  const account = await repo.findById(accountId);

  // ✅ FIX: Check if the account exists before trying to read its balance
  if (!account) {
    const error = new Error('The account you are trying to delete could not be found.');
    error.status = 404;
    throw error;
  }

  // Rule: Do not drop accounts holding active capital assets
  if (Number(account.balance) !== 0) {
    throw new Error('Cannot delete account records containing non-zero account balances.');
  }

  return true;
}

async function removeAccount(accountId, userId) {
  // This will now throw a clean 404 error instead of causing a TypeError crash
  await canDeleteAccount(accountId, userId);
  return await repo.deleteAccount(accountId, userId); // Pass userId for security context alignment
}

async function recoverAllAccounts(userId) {
  try {
    return await repo.restoreAllByUser(userId);
  } catch (error) {
    logger.error(`[ACCOUNTS_SERVICE_BULK_RECOVERY_ERROR]: ${error.message}`);
    throw error;
  }
}

module.exports = {
  createAccount,
  getAccountsByUser,
  updateAccount,
  archiveAccount,
  restoreAccount,
  setDefaultAccount,
  deposit,
  withdraw,
  transferFunds,
  calculateNetWorth,
  getDashboardMetrics,
  buildAIContext,
  removeAccount,
  validateOwnership,
  recoverAllAccounts
};