const { 
  calculateCompleteTaxFiling
} = require("./tax.service.js");
const ruleEngine = require("./rule_engine.js");

const crypto = require("crypto");

/**
 * ============================================================================
 * HELPER UTILITIES
 * ============================================================================
 */

function generateCsvExport(filing) {
  const headers = [
    "Transaction ID",
    "Asset Type",
    "Gain Type",
    "Gain Amount",
    "Loss Amount",
    "Tax Liability"
  ];

  const rows = (filing.transactions || []).map(t => [
    t.transactionId,
    t.assetType || "N/A",
    t.gainType,
    t.gainAmount,
    t.lossAmount,
    t.taxLiability
  ]);

  rows.push([
    "",
    "",
    "TOTALS",
    filing.totalCapitalGains,
    filing.totalCapitalLosses,
    filing.totalTaxLiability
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map(row => row.map(cell => `"${cell || 0}"`).join(","))
  ].join("\n");

  return csvContent;
}

/**
 * ============================================================================
 * CORE ROUTE HANDLERS
 * ============================================================================
 */

async function calculateTax(dataRepository, req, res, next) {
  try {
    const request = req.body;
    const userId = req.user?.id || "anonymous";

    // Validate required fields
    if (!request.transactions || !Array.isArray(request.transactions)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "transactions array is required",
          details: { provided: typeof request.transactions }
        }
      });
    }

    if (!request.taxYear) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "taxYear is required"
        }
      });
    }

    request.baseCurrency = request.baseCurrency || "PKR";
    request.jurisdiction = request.jurisdiction || "PAKISTAN";

    if (request.jurisdiction === "PK") {
      request.jurisdiction = "PAKISTAN";
    }

    let taxConfig;
    if (request.jurisdiction === "PAKISTAN") {
      try {
        taxConfig = ruleEngine.getRules("PAKISTAN", request.taxYear);
        taxConfig.taxYear = request.taxYear;
        taxConfig.jurisdiction = "PAKISTAN";
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: {
            code: "RULESET_NOT_FOUND",
            message: `Ruleset not found for Pakistan in year ${request.taxYear}`
          }
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Unsupported jurisdiction",
          details: {
            jurisdiction: request.jurisdiction,
            supportedJurisdictions: ["PAKISTAN"]
          }
        }
      });
    }

    // ✅ Convert date strings to Date objects AND add jurisdiction/taxYear to each transaction
    const transactions = request.transactions.map(t => ({
      ...t,
      jurisdiction: request.jurisdiction,  // ← ADD jurisdiction from request to each transaction
      taxYear: request.taxYear,            // ← ADD taxYear from request to each transaction
      acquisitionDate: new Date(t.acquisitionDate),
      disposalDate: t.disposalDate ? new Date(t.disposalDate) : undefined
    }));

    // ✅ FIX: Pass arguments in correct order: (db, taxFilerId, transactions, taxConfig)
    const filingSummary = await calculateCompleteTaxFiling(
      dataRepository.db,      // ← First arg: database connection
      userId,                  // ← Second arg: tax filer ID
      transactions,            // ← Third arg: transactions array
      taxConfig                // ← Fourth arg: tax configuration
    );

    // Generate a clean UUID v4 identifier
    const generatedFilingId = crypto.randomUUID();

    // Persist computed data to storage
    const savedFiling = await dataRepository.saveTaxFiling({
      filingId: generatedFilingId,
      taxFilerId: userId,
      taxYear: request.taxYear,
      jurisdiction: request.jurisdiction,
      ...filingSummary
    });

    res.status(200).json({
      success: true,
      data: savedFiling,
      auditLog: savedFiling.auditLog,
      meta: {
        filingId: savedFiling.filingId,
        calculatedAt: new Date(),
        transactionCount: filingSummary.transactionCount
      }
    });
  } catch (error) {
    next(error);
  }
}

async function getFilingDetails(dataRepository, req, res, next) {
  try {
    const { filingId } = req.params;

    const filingData = await dataRepository.getFilingById(filingId);
    if (!filingData) {
      return res.status(404).json({
        success: false,
        error: {
          code: "FILING_NOT_FOUND",
          message: `Filing ${filingId} not found`,
          details: { filingId }
        }
      });
    }

    res.status(200).json({
      success: true,
      data: filingData,
      meta: {
        filingId: filingData.filingId,
        status: filingData.status,
        calculationCount: filingData.transactions?.length || 0
      }
    });
  } catch (error) {
    next(error);
  }
}

async function listFilings(dataRepository, req, res, next) {
  try {
    const userId = req.user?.id || "anonymous";
    const { taxYear, status } = req.query;

    if (!taxYear) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_PARAMETER",
          message: "taxYear query parameter is required"
        }
      });
    }

    let filtered = await dataRepository.getTransactionsByYear(
      userId, 
      parseInt(taxYear, 10)
    );

    if (status) {
      filtered = filtered.filter(f => f.status === status);
    }

    res.status(200).json({
      success: true,
      data: filtered,
      meta: {
        total: filtered.length
      }
    });
  } catch (error) {
    next(error);
  }
}

async function submitFiling(dataRepository, req, res, next) {
  try {
    const { filingId } = req.params;

    const filing = await dataRepository.getFilingById(filingId);
    if (!filing) {
      return res.status(404).json({
        success: false,
        error: {
          code: "FILING_NOT_FOUND",
          message: `Filing ${filingId} not found`
        }
      });
    }

    if (filing.status !== "DRAFT") {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_STATE",
          message: `Cannot submit filing with status ${filing.status}`,
          details: { currentStatus: filing.status }
        }
      });
    }

    await dataRepository.db.query(
      "UPDATE tax_filings SET status = 'SUBMITTED', updated_at = NOW() WHERE filing_id = $1", 
      [filingId]
    );

    res.status(200).json({
      success: true,
      data: {
        filingId,
        status: "SUBMITTED",
        submissionDate: new Date()
      }
    });
  } catch (error) {
    next(error);
  }
}

async function getAuditLog(dataRepository, req, res, next) {
  try {
    const { filingId } = req.params;

    const filing = await dataRepository.getFilingById(filingId);
    if (!filing) {
      return res.status(404).json({
        success: false,
        error: {
          code: "FILING_NOT_FOUND",
          message: `Filing ${filingId} not found`
        }
      });
    }

    const auditLog = filing.auditLog || [];

    res.status(200).json({
      success: true,
      data: auditLog,
      meta: {
        filingId,
        totalEntries: auditLog.length,
        successCount: auditLog.filter(e => e.status === "SUCCESS").length,
        errorCount: auditLog.filter(e => e.status === "ERROR").length,
        warningCount: auditLog.filter(e => e.status === "WARNING").length
      }
    });
  } catch (error) {
    next(error);
  }
}

async function exportFiling(dataRepository, req, res, next) {
  try {
    const { filingId } = req.params;
    const { format = "json" } = req.query;

    const filingData = await dataRepository.getFilingById(filingId);
    if (!filingData) {
      return res.status(404).json({
        success: false,
        error: {
          code: "FILING_NOT_FOUND",
          message: `Filing ${filingId} not found`
        }
      });
    }

    switch (format.toLowerCase()) {
      case "json":
        res.status(200).json({
          success: true,
          data: filingData
        });
        break;

      case "csv":
        const csvContent = generateCsvExport(filingData);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="tax-filing-${filingId}.csv"`
        );
        res.send(csvContent);
        break;

      case "pdf":
        res.status(501).json({
          success: false,
          error: {
            code: "NOT_IMPLEMENTED",
            message: "PDF export not yet implemented"
          }
        });
        break;

      default:
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_FORMAT",
            message: `Unsupported export format: ${format}`
          }
        });
    }
  } catch (error) {
    next(error);
  }
}

async function getTaxSummary(dataRepository, req, res, next) {
  try {
    const userId = req.user?.id || "anonymous";
    const { taxYear } = req.query;

    if (!taxYear) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_PARAMETER",
          message: "taxYear parameter is required"
        }
      });
    }

    const year = parseInt(taxYear, 10);
    const queryText = `
      SELECT * FROM tax_filings 
      WHERE tax_filer_id = $1 AND tax_year = $2 
      LIMIT 1;
    `;
    const { rows } = await dataRepository.db.query(queryText, [userId, year]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_FILING_FOUND",
          message: `No filing found for year ${year}`
        }
      });
    }

    const summary = rows[0];

    res.status(200).json({
      success: true,
      data: {
        taxYear: summary.tax_year,
        jurisdiction: summary.jurisdiction,
        totalCapitalGains: summary.total_capital_gains,
        totalCapitalLosses: summary.total_capital_losses,
        netCapitalGain: summary.net_capital_gain,
        totalTaxLiability: summary.total_tax_liability,
        filingStatus: summary.status
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * ============================================================================
 * ERROR HANDLING MIDDLEWARE
 * ============================================================================
 */

function errorHandler(error, req, res, next) {
  console.error("Error encountered:", error);

  const errorCode = error.code || "INTERNAL_ERROR";
  const errorMessage = error.message || "An unexpected error occurred";
  const errorDetails = error.context || error.details || {};

  if (error.name === "ValidationError") {
    res.status(400).json({
      success: false,
      error: { code: errorCode, message: errorMessage, details: errorDetails }
    });
  } else if (error.name === "TaxCalculationError") {
    res.status(422).json({
      success: false,
      error: { code: errorCode, message: errorMessage, details: errorDetails, severity: error.severity }
    });
  } else if (error.name === "DataAccessError") {
    res.status(503).json({
      success: false,
      error: { code: errorCode, message: errorMessage, details: errorDetails }
    });
  } else {
    res.status(500).json({
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
        details: process.env.NODE_ENV === "development" ? { stack: error.stack } : {}
      }
    });
  }
}

module.exports = {
  calculateTax,
  getFilingDetails,
  listFilings,
  submitFiling,
  getAuditLog,
  exportFiling,
  getTaxSummary,
  errorHandler
};