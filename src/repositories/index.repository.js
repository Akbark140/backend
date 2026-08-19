// repositories/index.repository.js

const db = require("../config/db.config"); // Adjust this path to match your DB connection pool file

/**
 * Persists a completely calculated tax filing and its child transactions/audit logs into the DB.
 * Uses a standard database transaction block to guarantee atomic writes across relations.
 * * @param {Object} filing - The complete aggregated calculation summary matrix
 * @returns {Promise<Object>} The successfully saved and re-mapped filing summary entity
 */// repositories/index.repository.js
 
async function saveTaxFiling(filing) {
  try {
    await db.query("BEGIN");

    const filingQuery = `
      INSERT INTO tax_filings (
        filing_id, tax_filer_id, tax_year, jurisdiction,
        total_capital_gains, total_capital_losses, net_capital_gain,
        total_tax_liability, estimated_tax_payable, capital_loss_carryforward,
        carryforward_expiry_year, transaction_count, audit_log, status, last_modified
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'DRAFT', NOW())
      
      -- FIXED: Target the composite constraint that caused the duplicate key crash
      ON CONFLICT (tax_filer_id, tax_year, jurisdiction) 
      DO UPDATE SET
        total_capital_gains = EXCLUDED.total_capital_gains,
        total_capital_losses = EXCLUDED.total_capital_losses,
        net_capital_gain = EXCLUDED.net_capital_gain,
        total_tax_liability = EXCLUDED.total_tax_liability,
        estimated_tax_payable = EXCLUDED.estimated_tax_payable,
        capital_loss_carryforward = EXCLUDED.capital_loss_carryforward,
        transaction_count = EXCLUDED.transaction_count,
        audit_log = EXCLUDED.audit_log,
        last_modified = NOW()
      RETURNING *;
    `;

    const filingValues = [
      filing.filingId,
      filing.taxFilerId,
      filing.taxYear,
      filing.jurisdiction,
      filing.totalCapitalGains,
      filing.totalCapitalLosses,
      filing.netCapitalGain,
      filing.totalTaxLiability,
      filing.estimatedTaxPayable,
      filing.capitalLossCarryforward,
      filing.carryforwardExpiryYear,
      filing.transactionCount,
      JSON.stringify(filing.auditLog)
    ];

    // 1. Execute parent query and safely unpack row outcome mapping
    const { rows: [savedFiling] } = await db.query(filingQuery, filingValues);

    if (!savedFiling) {
      throw new Error("Failed to persist tax filing parent record; row outcome is empty.");
    }

    // CRITICAL FIX: Extract the persistent database-level filing ID
    const actualFilingId = savedFiling.filing_id;

    // 2. Clear out pre-existing child calculations using the persistent database ID
    await db.query("DELETE FROM tax_transaction_calculations WHERE filing_id = $1", [actualFilingId]);

    // 3. Write downstream calculations using top-level db reference
    if (filing.transactions && filing.transactions.length > 0) {
      const calcInsertQuery = `
        INSERT INTO tax_transaction_calculations (
          transaction_id, filing_id, asset_type, gain_type,
          acquisition_cost_total, disposal_proceeds, gain_amount, loss_amount,
          holding_days, applicable_tax_rate, taxable_gain, tax_liability, calculated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);
      `;

      for (const calc of filing.transactions) {
        await db.query(calcInsertQuery, [
          calc.transactionId,
          actualFilingId, // FIXED: Changed from filing.filingId to prevent foreign key errors
          calc.assetType,
          calc.gainType,
          calc.acquisitionCostTotal,
          calc.disposalProceeds,
          calc.gainAmount,
          calc.lossAmount,
          calc.holdingDays,
          calc.applicableTaxRate,
          calc.taxableGain,
          calc.taxLiability,
          calc.calculatedAt || new Date()
        ]);
      }
    }

    await db.query("COMMIT");

    // 4. Return structural DTO reflecting true relational mapping state
    return {
      filingId: actualFilingId, // FIXED: Return the real identifier used in the DB row
      taxFilerId: savedFiling.tax_filer_id,
      taxYear: savedFiling.tax_year,
      jurisdiction: savedFiling.jurisdiction,
      status: savedFiling.status,
      totalCapitalGains: savedFiling.total_capital_gains,
      totalCapitalLosses: savedFiling.total_capital_losses,
      netCapitalGain: savedFiling.net_capital_gain,
      totalTaxLiability: savedFiling.total_tax_liability,
      transactionCount: savedFiling.transaction_count,
      transactions: filing.transactions || [],
      auditLog: typeof savedFiling.audit_log === "string" ? JSON.parse(savedFiling.audit_log) : savedFiling.audit_log
    };

  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/**
 * Retrieves a single compiled tax filing matrix by its UUID.
 */
async function getFilingById(filingId) {
  const filingQuery = `SELECT * FROM tax_filings WHERE filing_id = $1 LIMIT 1;`;
  const { rows } = await db.query(filingQuery, [filingId]);

  if (rows.length === 0) return null;
  const target = rows[0];

  // Pull active computed sub-transactions bound to this record context
  const childTransactionsQuery = `SELECT * FROM tax_transaction_calculations WHERE filing_id = $1;`;
  const { rows: childRows } = await db.query(childTransactionsQuery, [filingId]);

  return {
    filingId: target.filing_id,
    taxFilerId: target.tax_filer_id,
    taxYear: target.tax_year,
    jurisdiction: target.jurisdiction,
    status: target.status,
    totalCapitalGains: target.total_capital_gains,
    totalCapitalLosses: target.total_capital_losses,
    netCapitalGain: target.net_capital_gain,
    totalTaxLiability: target.total_tax_liability,
    capitalLossCarryforward: target.capital_loss_carryforward,
    carryforwardExpiryYear: target.carryforward_expiry_year,
    auditLog: typeof target.audit_log === "string" ? JSON.parse(target.audit_log) : target.audit_log,
    transactions: childRows.map(c => ({
      transactionId: c.transaction_id,
      assetType: c.asset_type,
      gainType: c.gain_type,
      acquisitionCostTotal: c.acquisition_cost_total,
      disposalProceeds: c.disposal_proceeds,
      gainAmount: c.gain_amount,
      lossAmount: c.loss_amount,
      holdingDays: c.holding_days,
      applicableTaxRate: parseFloat(c.applicable_tax_rate),
      taxableGain: c.taxable_gain,
      taxLiability: c.tax_liability
    }))
  };
}

/**
 * Lists all active filing summary records filtered under a targeting user context and tax year.
 */
async function getTransactionsByYear(userId, taxYear) {
  const queryText = `
    SELECT filing_id, tax_filer_id, tax_year, jurisdiction, status, 
           total_tax_liability, total_capital_gains, total_capital_losses, net_capital_gain
    FROM tax_filings
    WHERE tax_filer_id = $1 AND tax_year = $2
    ORDER BY last_modified DESC;
  `;
  
  const { rows } = await db.query(queryText, [userId, taxYear]);
  
  return rows.map(r => ({
    filingId: r.filing_id,
    taxFilerId: r.tax_filer_id,
    taxYear: r.tax_year,
    jurisdiction: r.jurisdiction,
    status: r.status,
    totalTaxLiability: r.total_tax_liability,
    totalCapitalGains: r.total_capital_gains,
    totalCapitalLosses: r.total_capital_losses,
    netCapitalGain: r.net_capital_gain
  }));
}

// Expose the global database driver access along with pure functional layers 
module.exports = {
  db,
  saveTaxFiling,
  getFilingById,
  getTransactionsByYear
};