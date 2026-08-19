const transactionsService = require('./transactions.service');
const {
  createTransactionSchema,
  updateTransactionSchema,
  listTransactionsSchema,
} = require('./transactions.schema');
async function getAllTransactions(req, res, next) {
  try {
    const userId = req.user.id;
    const filters = listTransactionsSchema.parse(req.query);
    const result = await transactionsService.list(userId, filters);

    // Use the meta from the service (it has the correct total and pagination)
    const transactionsArray = Array.isArray(result) ? result : (result?.data || []);
    const meta = result?.meta || {
      page: filters.page || 1,
      totalPages: 1,
      total: transactionsArray.length
    };

    return res.status(200).json({
      success: true,
      data: transactionsArray,
      meta,  //Use the correct meta from service!
    });
  } catch (error) {
    return next(error);
  }
}

async function getTransactionById(req, res, next) {
  try {
    const transaction = await transactionsService.getById(req.params.id, req.user.id);

    return res.status(200).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    return next(error);
  }
}

async function createTransaction(req, res, next) {
  try {
    const input = createTransactionSchema.parse(req.body);
    const transaction = await transactionsService.create(req.user.id, input);

    return res.status(201).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    return next(error);
  }
}

async function updateTransaction(req, res, next) {
  try {
    const input = updateTransactionSchema.parse(req.body);
    const transaction = await transactionsService.update(
      req.params.id,
      req.user.id,
      input
    );

    return res.status(200).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteTransaction(req, res, next) {
  try {
    await transactionsService.remove(req.params.id, req.user.id);

    return res.status(200).json({
      success: true,
      message: 'Transaction successfully removed.',
    });
  } catch (error) {
    return next(error);
  }
}

// Add this to your transactions.controller.js file:

// 📂 controllers/transactions.controller.js

async function getMonthlyReport(req, res, next) {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;

    const now = new Date();
    const start = startDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const end = endDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;

    // OPTIMIZATION: Call the index-optimized repository query instead of parsing rows in Node memory
    const transactionRepository = require('./transactions.repository');
    const summary = await transactionRepository.getMonthlySummary(userId, start, end);

    return res.status(200).json({
      success: true,
      totalIncome: Number(summary.income),
      totalExpenses: Number(summary.expenses),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAllTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  getMonthlyReport
};
