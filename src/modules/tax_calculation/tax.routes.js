const { Router } = require("express");

const { authenticate } = require("../../middleware/authorize.middleware");
const { readOperationLimiter } = require("../../middleware/rateLimiter.middleware");
const taxController = require("./tax.controller");

// Import your live repository container layer directly to feed the functional controller
const dataRepository = require("../../repositories/index.repository"); 

const router = Router();

// ── Public Endpoints ─────────────────────────────────────────────────────────
router.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date(),
    service: "tax-calculation-api"
  });
});

// ── Authenticated User Endpoints ─────────────────────────────────────────────
router.post(
  "/calculate", 
  authenticate, 
  (req, res, next) => taxController.calculateTax(dataRepository, req, res, next)
);

router.get(
  "/filings", 
  authenticate, 
  readOperationLimiter, 
  (req, res, next) => taxController.listFilings(dataRepository, req, res, next)
);

router.get(
  "/filings/:filingId", 
  authenticate, 
  (req, res, next) => taxController.getFilingDetails(dataRepository, req, res, next)
);

router.get(
  "/filings/:filingId/audit-log", 
  authenticate, 
  (req, res, next) => taxController.getAuditLog(dataRepository, req, res, next)
);

router.get(
  "/filings/:filingId/export", 
  authenticate, 
  (req, res, next) => taxController.exportFiling(dataRepository, req, res, next)
);

router.get(
  "/summary", 
  authenticate, 
  (req, res, next) => taxController.getTaxSummary(dataRepository, req, res, next)
);

// ── Privileged Administrative Endpoints / State Transitions ──────────────────
router.post(
  "/filings/:filingId/submit", 
  authenticate, 
  (req, res, next) => taxController.submitFiling(dataRepository, req, res, next)
);

// ── Error Handling Middleware ────────────────────────────────────────────────
router.use(taxController.errorHandler);

module.exports = router;