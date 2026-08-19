const { DataAccessError } = require("./types.js");

function getAssetsByTaxFiler(db, taxFilerId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        asset_id as assetId,
        tax_filer_id as taxFilerId,
        asset_type as assetType,
        asset_name as assetName,
        quantity,
        current_value as currentValue,
        currency,
        last_updated as lastUpdated,
        is_active as isActive,
        metadata
      FROM assets
      WHERE tax_filer_id = ?
        AND is_active = 1
      ORDER BY last_updated DESC
    `);

    const rows = stmt.all(taxFilerId);

    return rows.map(row => ({
      assetId: row.assetId,
      taxFilerId: row.taxFilerId,
      assetType: row.assetType,
      assetName: row.assetName,
      quantity: row.quantity,
      currentValue: row.currentValue,
      currency: row.currency,
      lastUpdated: new Date(row.lastUpdated),
      isActive: Boolean(row.isActive),
      metadata: JSON.parse(row.metadata || "{}")
    }));
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch assets for tax filer ${taxFilerId}`,
      { taxFilerId, originalError: error }
    );
  }
}

function getAssetById(db, assetId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        asset_id as assetId,
        tax_filer_id as taxFilerId,
        asset_type as assetType,
        asset_name as assetName,
        quantity,
        current_value as currentValue,
        currency,
        last_updated as lastUpdated,
        is_active as isActive,
        metadata
      FROM assets
      WHERE asset_id = ?
    `);

    const row = stmt.get(assetId);

    if (!row) return null;

    return {
      assetId: row.assetId,
      taxFilerId: row.taxFilerId,
      assetType: row.assetType,
      assetName: row.assetName,
      quantity: row.quantity,
      currentValue: row.currentValue,
      currency: row.currency,
      lastUpdated: new Date(row.lastUpdated),
      isActive: Boolean(row.isActive),
      metadata: JSON.parse(row.metadata || "{}")
    };
  } catch (error) {
    throw new DataAccessError(`Failed to fetch asset ${assetId}`, {
      assetId,
      originalError: error
    });
  }
}

function upsertAsset(db, asset) {
  try {
    return db.transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO assets (
          asset_id, tax_filer_id, asset_type, asset_name, quantity,
          current_value, currency, last_updated, is_active, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
          quantity = ?,
          current_value = ?,
          currency = ?,
          last_updated = ?,
          metadata = ?
      `);

      stmt.run(
        asset.assetId,
        asset.taxFilerId,
        asset.assetType,
        asset.assetName,
        asset.quantity,
        asset.currentValue,
        asset.currency,
        asset.lastUpdated.toISOString(),
        asset.isActive ? 1 : 0,
        JSON.stringify(asset.metadata),
        asset.quantity,
        asset.currentValue,
        asset.currency,
        asset.lastUpdated.toISOString(),
        JSON.stringify(asset.metadata)
      );

      return asset.assetId;
    })();
  } catch (error) {
    throw new DataAccessError(`Failed to upsert asset ${asset.assetId}`, {
      asset,
      originalError: error
    });
  }
}

function deleteAsset(db, assetId) {
  try {
    const stmt = db.prepare(`
      UPDATE assets
      SET is_active = 0, last_updated = ?
      WHERE asset_id = ?
    `);

    stmt.run(new Date().toISOString(), assetId);
  } catch (error) {
    throw new DataAccessError(`Failed to delete asset ${assetId}`, {
      assetId,
      originalError: error
    });
  }
}


function saveTaxCalculation(
  db,
  taxFilerId,
  transactionId,
  calculation,
  filingId
) {
  try {
    const calculationId = `calc_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 11)}`;

    const stmt = db.prepare(`
      INSERT INTO tax_calculations (
        calculation_id, filing_id, tax_filer_id, transaction_id,
        gain_amount, loss_amount, tax_liability, gain_type,
        calculation_data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      calculationId,
      filingId || null,
      taxFilerId,
      transactionId,
      calculation.gainAmount,
      calculation.lossAmount,
      calculation.taxLiability,
      calculation.gainType,
      JSON.stringify(calculation),
      new Date().toISOString()
    );

    return calculationId;
  } catch (error) {
    throw new DataAccessError(
      `Failed to save tax calculation for transaction ${transactionId}`,
      {
        transactionId,
        calculation,
        originalError: error
      }
    );
  }
}

function getCalculationsByFilingId(db, filingId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        calculation_id as calculationId,
        filing_id as filingId,
        tax_filer_id as taxFilerId,
        transaction_id as transactionId,
        gain_amount as gainAmount,
        loss_amount as lossAmount,
        tax_liability as taxLiability,
        gain_type as gainType,
        calculation_data as calculationData,
        created_at as createdAt
      FROM tax_calculations
      WHERE filing_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(filingId);

    return rows.map(row => ({
      calculationId: row.calculationId,
      filingId: row.filingId,
      taxFilerId: row.taxFilerId,
      transactionId: row.transactionId,
      gainAmount: row.gainAmount,
      lossAmount: row.lossAmount,
      taxLiability: row.taxLiability,
      gainType: row.gainType,
      calculationData: JSON.parse(row.calculationData),
      createdAt: new Date(row.createdAt)
    }));
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch calculations for filing ${filingId}`,
      {
        filingId,
        originalError: error
      }
    );
  }
}

function getCalculationsByTaxFilerAndYear(db, taxFilerId, taxYear) {
  try {
    const stmt = db.prepare(`
      SELECT 
        calculation_id as calculationId,
        filing_id as filingId,
        tax_filer_id as taxFilerId,
        transaction_id as transactionId,
        gain_amount as gainAmount,
        loss_amount as lossAmount,
        tax_liability as taxLiability,
        gain_type as gainType,
        calculation_data as calculationData,
        created_at as createdAt
      FROM tax_calculations
      WHERE tax_filer_id = ?
        AND strftime('%Y', created_at) = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(taxFilerId, String(taxYear));

    return rows.map(row => ({
      calculationId: row.calculationId,
      filingId: row.filingId,
      taxFilerId: row.taxFilerId,
      transactionId: row.transactionId,
      gainAmount: row.gainAmount,
      lossAmount: row.lossAmount,
      taxLiability: row.taxLiability,
      gainType: row.gainType,
      calculationData: JSON.parse(row.calculationData),
      createdAt: new Date(row.createdAt)
    }));
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch calculations for filer ${taxFilerId} year ${taxYear}`,
      {
        taxFilerId,
        taxYear,
        originalError: error
      }
    );
  }
}

function saveTaxFiling(db, taxFilerId, filing) {
  try {
    const stmt = db.prepare(`
      INSERT INTO tax_filings (
        filing_id, tax_filer_id, tax_year, jurisdiction,
        filing_data, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      filing.filingId,
      taxFilerId,
      filing.taxYear,
      filing.jurisdiction,
      JSON.stringify(filing),
      "DRAFT",
      new Date().toISOString(),
      new Date().toISOString()
    );

    return filing.filingId;
  } catch (error) {
    throw new DataAccessError(
      `Failed to save tax filing for filer ${taxFilerId}`,
      { taxFilerId, filing, originalError: error }
    );
  }
}

function getFilingById(db, filingId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        filing_id as filingId,
        tax_filer_id as taxFilerId,
        tax_year as taxYear,
        jurisdiction,
        filing_data as filingData,
        status,
        submission_date as submissionDate,
        created_at as createdAt,
        updated_at as updatedAt
      FROM tax_filings
      WHERE filing_id = ?
    `);

    const row = stmt.get(filingId);
    if (!row) return null;

    return {
      filingId: row.filingId,
      taxFilerId: row.taxFilerId,
      taxYear: row.taxYear,
      jurisdiction: row.jurisdiction,
      filingData: JSON.parse(row.filingData),
      status: row.status,
      submissionDate: row.submissionDate
        ? new Date(row.submissionDate)
        : undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  } catch (error) {
    throw new DataAccessError(`Failed to fetch filing ${filingId}`, {
      filingId,
      originalError: error
    });
  }
}

function getFilingsByTaxFiler(db, taxFilerId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        filing_id as filingId,
        tax_filer_id as taxFilerId,
        tax_year as taxYear,
        jurisdiction,
        filing_data as filingData,
        status,
        submission_date as submissionDate,
        created_at as createdAt,
        updated_at as updatedAt
      FROM tax_filings
      WHERE tax_filer_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(taxFilerId);

    return rows.map(row => ({
      filingId: row.filingId,
      taxFilerId: row.taxFilerId,
      taxYear: row.taxYear,
      jurisdiction: row.jurisdiction,
      filingData: JSON.parse(row.filingData),
      status: row.status,
      submissionDate: row.submissionDate
        ? new Date(row.submissionDate)
        : undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }));
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch filings for tax filer ${taxFilerId}`,
      { taxFilerId, originalError: error }
    );
  }
}

function getFilingByTaxFilerAndYear(db, taxFilerId, taxYear) {
  try {
    const stmt = db.prepare(`
      SELECT 
        filing_id as filingId,
        tax_filer_id as taxFilerId,
        tax_year as taxYear,
        jurisdiction,
        filing_data as filingData,
        status,
        submission_date as submissionDate,
        created_at as createdAt,
        updated_at as updatedAt
      FROM tax_filings
      WHERE tax_filer_id = ? AND tax_year = ?
      LIMIT 1
    `);

    const row = stmt.get(taxFilerId, taxYear);
    if (!row) return null;

    return {
      filingId: row.filingId,
      taxFilerId: row.taxFilerId,
      taxYear: row.taxYear,
      jurisdiction: row.jurisdiction,
      filingData: JSON.parse(row.filingData),
      status: row.status,
      submissionDate: row.submissionDate
        ? new Date(row.submissionDate)
        : undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch filing for filer ${taxFilerId} year ${taxYear}`,
      { taxFilerId, taxYear, originalError: error }
    );
  }
}

function updateFilingStatus(db, filingId, status) {
  try {
    const stmt = db.prepare(`
      UPDATE tax_filings
      SET status = ?, updated_at = ?
      WHERE filing_id = ?
    `);

    stmt.run(status, new Date().toISOString(), filingId);
  } catch (error) {
    throw new DataAccessError(`Failed to update filing ${filingId} status`, {
      filingId,
      status,
      originalError: error
    });
  }
}

function submitFiling(db, filingId) {
  try {
    const stmt = db.prepare(`
      UPDATE tax_filings
      SET status = ?, submission_date = ?, updated_at = ?
      WHERE filing_id = ?
    `);

    stmt.run(
      "SUBMITTED",
      new Date().toISOString(),
      new Date().toISOString(),
      filingId
    );
  } catch (error) {
    throw new DataAccessError(`Failed to submit filing ${filingId}`, {
      filingId,
      originalError: error
    });
  }
}


function saveFiling(db, taxFilerId, filing) {
  try {
    const result = db.transaction(() => {
      const filingId = saveTaxFiling(db, taxFilerId, filing);

      const calculationIds = filing.transactions.map(calc =>
        saveTaxCalculation(
          db,
          taxFilerId,
          calc.transactionId,
          calc,
          filingId
        )
      );

      return { filingId, calculationIds };
    })();

    return result;
  } catch (error) {
    throw new DataAccessError(
      `Failed to save filing transaction for filer ${taxFilerId}`,
      {
        taxFilerId,
        originalError: error
      }
    );
  }
}

function getCompleteFiling(db, filingId) {
  try {
    const filing = getFilingById(db, filingId);
    if (!filing) return null;

    const calculations = getCalculationsByFilingId(db, filingId);

    return { filing, calculations };
  } catch (error) {
    throw new DataAccessError(
      `Failed to retrieve complete filing ${filingId}`,
      {
        filingId,
        originalError: error
      }
    );
  }
}

// ============================================================================
// TRANSACTION OPERATIONS
// ============================================================================

function getTransactionsByAssetId(db, assetId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        transaction_id as transactionId,
        asset_id as assetId,
        tax_filer_id as taxFilerId,
        transaction_type as transactionType,
        quantity,
        unit_price as unitPrice,
        transaction_date as transactionDate,
        total_amount as totalAmount,
        currency,
        notes,
        created_at as createdAt,
        updated_at as updatedAt
      FROM transactions
      WHERE asset_id = ?
      ORDER BY transaction_date DESC
    `);

    const rows = stmt.all(assetId);

    return rows.map(row => ({
      transactionId: row.transactionId,
      assetId: row.assetId,
      taxFilerId: row.taxFilerId,
      transactionType: row.transactionType,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      transactionDate: new Date(row.transactionDate),
      totalAmount: row.totalAmount,
      currency: row.currency,
      notes: row.notes,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }));
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch transactions for asset ${assetId}`,
      { assetId, originalError: error }
    );
  }
}

function getTransactionsByTaxFilerAndYear(db, taxFilerId, taxYear) {
  try {
    const stmt = db.prepare(`
      SELECT 
        transaction_id as transactionId,
        asset_id as assetId,
        tax_filer_id as taxFilerId,
        transaction_type as transactionType,
        quantity,
        unit_price as unitPrice,
        transaction_date as transactionDate,
        total_amount as totalAmount,
        currency,
        notes,
        created_at as createdAt,
        updated_at as updatedAt
      FROM transactions
      WHERE tax_filer_id = ?
        AND strftime('%Y', transaction_date) = ?
      ORDER BY transaction_date DESC
    `);

    const rows = stmt.all(taxFilerId, String(taxYear));

    return rows.map(row => ({
      transactionId: row.transactionId,
      assetId: row.assetId,
      taxFilerId: row.taxFilerId,
      transactionType: row.transactionType,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      transactionDate: new Date(row.transactionDate),
      totalAmount: row.totalAmount,
      currency: row.currency,
      notes: row.notes,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }));
  } catch (error) {
    throw new DataAccessError(
      `Failed to fetch transactions for filer ${taxFilerId} year ${taxYear}`,
      { taxFilerId, taxYear, originalError: error }
    );
  }
}

function createTransaction(db, transaction) {
  try {
    return db.transaction(() => {
      const { v4: uuidv4 } = require("uuid");
      const transactionId = transaction.transactionId || `txn_${uuidv4()}`;

      const stmt = db.prepare(`
        INSERT INTO transactions (
          transaction_id, asset_id, tax_filer_id, transaction_type,
          quantity, unit_price, transaction_date, total_amount,
          currency, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        transactionId,
        transaction.assetId,
        transaction.taxFilerId,
        transaction.transactionType,
        transaction.quantity,
        transaction.unitPrice,
        transaction.transactionDate.toISOString(),
        transaction.totalAmount,
        transaction.currency,
        transaction.notes || null,
        new Date().toISOString(),
        new Date().toISOString()
      );

      return transactionId;
    })();
  } catch (error) {
    throw new DataAccessError(
      `Failed to create transaction for asset ${transaction.assetId}`,
      { transaction, originalError: error }
    );
  }
}

module.exports = {
  getAssetsByTaxFiler,
  getAssetById,
  upsertAsset,
  deleteAsset,
  getTransactionsByAssetId,
  getTransactionsByTaxFilerAndYear,
  createTransaction,
  saveTaxCalculation,
  getCalculationsByFilingId,
  getCalculationsByTaxFilerAndYear,
  saveTaxFiling,
  getFilingById,
  getFilingsByTaxFiler,
  getFilingByTaxFilerAndYear,
  updateFilingStatus,
  submitFiling,
  saveFiling,
  getCompleteFiling
};