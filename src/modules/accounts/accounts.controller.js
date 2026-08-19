// src/modules/accounts/accounts.controller.js

const service = require('./accounts.service');
const repo    = require('./accounts.repository');
const schema  = require('./accounts.schema');

async function create(req, res, next) {
  try {
    
    const { error, value } = schema.validateCreateAccount.validate(req.body);
    
    if (error) return res.status(400).json({ 
      success: false, 
      errors: error.details.map(d => d.message) 
    });

    const account = await service.createAccount(req.user.id, value);
    
    return res.status(201).json({ 
      success: true, 
      data: account 
    });

  } catch (err) { 
    next(err); 
  }
}

async function findByUserId(req, res, next) {
  try {
    const accounts = await repo.findByUserId(req.user.id);
    return res.status(200).json({ success: true, data: accounts });
  } catch (err) { next(err); }
}

/**
 * GET /api/accounts
 * Retrieves all connected financial ledgers for the current user session
 */
async function list(req, res, next) {
  try {
    const userId = req.user.id; // Extracted safely from your auth middleware
    
    const accountsList = await service.getAccountsByUser(userId);

    return res.status(200).json({
      success: true,
      message: "User financial accounts fetched successfully.",
      count: accountsList.length,
      data: accountsList
    });
  } catch (error) {
    return next(error);
  }
}

async function getById(req, res, next) {
  try {
    await service.validateOwnership(req.params.id, req.user.id);
    const account = await repo.findById(req.params.id);
    return res.status(200).json({ success: true, data: account });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const accountId = req.params.id;
    const userId = req.user.id;
    const updateData = req.body;

    //  Explicit object wrapper delivery! Positional mixups are now structurally impossible.
    const updatedAccount = await service.updateAccount({ 
      accountId, 
      userId, 
      updateData 
    });
    
    if (!updatedAccount) {
      return res.status(404).json({
        success: false,
        message: "Account not found or user context validation failed."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account updated successfully.",
      data: updatedAccount
    });
  } catch (error) {
    return next(error);
  }
}

async function archive(req, res, next) {
  try {
    const accountId = req.params.id; // Ensure this matches your route parameter name (e.g., /:id)
    const userId = req.user.id;

    // Pass it inside an object wrapper to keep it synchronized with your service
    const archivedAccount = await service.archiveAccount({ 
      accountId, 
      userId 
    });
    
    if (!archivedAccount) {
      return res.status(404).json({
        success: false,
        message: "Account not found or authorization context failed."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account has been archived successfully.",
      data: archivedAccount
    });
  } catch (error) {
    return next(error);
  }
}

async function restore(req, res, next) {
  try {
    const accountId = req.params.id; // Make sure this matches your path parameter name
    const userId = req.user.id;

    //  Match the clean object parameters design pattern
    const restoredAccount = await service.restoreAccount({ 
      accountId, 
      userId 
    });
    
    if (!restoredAccount) {
      return res.status(404).json({
        success: false,
        message: "Account not found, or user lacks permissions to restore this record."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Financial account has been restored successfully.",
      data: restoredAccount
    });
  } catch (error) {
    return next(error);
  }
}

async function setDefault(req, res, next) {
  try {
    const account = await service.setDefaultAccount(req.params.id, req.user.id);
    return res.status(200).json({ success: true, message: 'Account marked as baseline profile default.', data: account });
  } catch (err) { next(err); }
}

async function deposit(req, res, next) {
  try {
    const { error, value } = schema.validateOperation.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const updated = await service.deposit(req.params.id, req.user.id, value.amount);
    return res.status(200).json({ success: true, balance: updated.balance, data: updated });
  } catch (err) { next(err); }
}

async function withdraw(req, res, next) {
  try {
    const { error, value } = schema.validateOperation.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const updated = await service.withdraw(req.params.id, req.user.id, value.amount);
    return res.status(200).json({ success: true, balance: updated.balance, data: updated });
  } catch (err) { next(err); }
}

async function transfer(req, res, next) {
  try {
    const { error, value } = schema.validateTransfer.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const updatedTarget = await service.transferFunds(req.params.id, value.targetAccountId, req.user.id, value.amount);
    return res.status(200).json({ success: true, message: 'Balance distribution transfer executed successfully.', data: updatedTarget });
  } catch (err) { next(err); }
}

async function summary(req, res, next) {
  try {
    const metrics = await service.getDashboardMetrics(req.user.id);
    return res.status(200).json({ success: true, data: metrics });
  } catch (err) { next(err); }
}

async function netWorth(req, res, next) {
  try {
    const snapshot = await service.calculateNetWorth(req.user.id);
    return res.status(200).json({ success: true, data: snapshot });
  } catch (err) { next(err); }
}

async function getAIContext(req, res, next) {
  try {
    const aiContext = await service.buildAIContext(req.user.id);
    return res.status(200).json({ success: true, data: aiContext });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    await service.removeAccount(req.params.id, req.user.id);
    return res.status(200).json({ success: true, message: 'Account execution records permanently deleted.' });
  } catch (err) { next(err); }
}

async function recoverAll(req, res, next) {
  try {
    const restoredRows = await service.recoverAllAccounts(req.user.id);
    return res.status(200).json({
      success: true,
      message: "Bulk conversion recovery operation finalized successfully.",
      count: restoredRows.length,
      data: restoredRows
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create, 
  list, 
  getById, 
  update, 
  archive, 
  restore, 
  setDefault, 
  deposit, 
  withdraw, 
  transfer, 
  summary, 
  netWorth, 
  getAIContext, 
  remove,
  recoverAll
};