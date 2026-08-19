// src/modules/import/import.routes.js
const express = require('express');
const { authenticate } = require('../../middleware/authorize.middleware');
const transactionService = require('../transactions/transactions.service');
const categoriesRepository = require('../categories/categories.repository');
const transactionRepository = require('../transactions/transactions.repository');

const router = express.Router();

/**
 * POST /api/transactions/import
 * Import multiple transactions in bulk from a parsed XLSX file.
 * Includes proper duplicate detection before attempting inserts.
 *
 * Body: {
 *   transactions: [
 *     { date: "2024-01-15", amount: 50.00, merchant: "Starbucks", category: "Food", notes: "Coffee" },
 *     ...
 *   ]
 * }
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { transactions } = req.body;
    const userId = req.user.id;

    // ── Input validation ────────────────────────────────────────────────────
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input',
        message: 'transactions must be a non-empty array',
      });
    }

    if (transactions.length > 10000) {
      return res.status(400).json({
        success: false,
        error: 'Too many transactions',
        message: 'Maximum 10,000 transactions per import',
      });
    }

    // ── Batch-resolve category names → UUIDs ────────────────────────────────
    const userCategories = await categoriesRepository.findAll(userId);
    const categoryMap = new Map(
      userCategories.map((c) => [c.name.toLowerCase(), c.id])
    );

    const fallbackCategoryId =
      userCategories.find((c) => c.type === 'expense')?.id ||
      userCategories[0]?.id ||
      null;

    // Fetch the user record once to get their default currency
    const userRecord = await transactionRepository.findUserById(userId);
    const userCurrency = userRecord?.currency || 'USD';

    // Build a map from category name → full category object (for type lookup)
    const categoryObjectMap = new Map(
      userCategories.map((c) => [c.name.toLowerCase(), c])
    );

    // ── Fetch all existing transactions for duplicate detection ──────────────
    // We need to check against existing transactions to avoid duplicates
    const existingTransactions = await transactionRepository.findAllUnpaginated(userId);

    // Create a set of duplicate signatures for quick lookup
    // Signature = date|amount|description (case-insensitive)
    const existingSignatures = new Set(
      existingTransactions.map((tx) => {
        const dateStr = typeof tx.date === 'string' 
          ? tx.date.split('T')[0]  // Handle ISO date string
          : new Date(tx.date).toISOString().split('T')[0];
        return `${dateStr}|${tx.amount}|${tx.description.toLowerCase()}`;
      })
    );

    // ── Classify each imported row ───────────────────────────────────────────
    const mapped = [];
    let duplicateCount = 0;
    let failedValidation = 0;

    for (const t of transactions) {
      // Validate required fields
      if (!t.date || t.amount === undefined || !t.merchant || !t.category) {
        failedValidation++;
        continue;
      }

      const categoryName = (t.category || '').trim().toLowerCase();
      const resolvedCategory = categoryObjectMap.get(categoryName);
      const resolvedCategoryId = resolvedCategory?.id || fallbackCategoryId;

      if (!resolvedCategoryId) {
        failedValidation++;
        continue;
      }

      const resolvedType =
        resolvedCategory?.type ||
        (t.type ? t.type.toLowerCase() : null) ||
        'expense';

      // Create signature for duplicate detection
      // Match against existing transactions
      const dateStr = typeof t.date === 'string'
        ? t.date.split('T')[0]
        : new Date(t.date).toISOString().split('T')[0];
      
      const signature = `${dateStr}|${Number(t.amount)}|${(t.merchant || '').toLowerCase()}`;

      // Check if this exact transaction already exists
      if (existingSignatures.has(signature)) {
        duplicateCount++;
        continue; // Skip this duplicate
      }

      // Add to processed list for insertion
      mapped.push({
        description: (t.merchant || t.description || 'Imported').trim(),
        amount: t.amount,
        type: resolvedType,
        date: t.date,
        currency: userCurrency,
        categoryId: resolvedCategoryId,
        notes: t.notes || null,
        isRecurring: false,
      });
    }

    // ── If no valid transactions to import, return early ─────────────────────
    if (mapped.length === 0) {
      return res.status(200).json({
        success: true,
        imported: 0,
        duplicates: duplicateCount,
        failed: failedValidation,
        total: transactions.length,
        message: `Import completed: 0 imported, ${duplicateCount} duplicates, ${failedValidation} validation errors`,
      });
    }

    // ── Bulk-create via existing service ────────────────────────────────────
    const result = await transactionService.bulkCreateTransactions(userId, mapped);

    const successful = Array.isArray(result) ? result : (result.successful || []);
    const failedItems = Array.isArray(result) ? [] : (result.failed || []);

    return res.status(200).json({
      success: true,
      imported: successful.length,
      duplicates: duplicateCount,
      failed: failedValidation + failedItems.length,
      total: transactions.length,
      message: `Successfully imported ${successful.length} of ${transactions.length} transactions`,
    });

  } catch (error) {
    console.error('Transaction import error:', error);
    return res.status(500).json({
      success: false,
      error: 'Import failed',
      message: error.message || 'An error occurred during import',
    });
  }
});

module.exports = router;