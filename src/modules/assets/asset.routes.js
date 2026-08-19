// asset.routes.js
const { Router } = require('express');
const { AssetRepository } = require('./asset.repository');
const { AssetService } = require('./asset.service');
const { AssetController } = require('./asset.controller');

// Import your verified middleware explicitly
const { authenticate } = require('../../middleware/authorize.middleware'); // Adjust this relative path to match your folder structure

const router = Router();

// Instantiate layers and cross-inject connections
const repository = new AssetRepository();
const service = new AssetService(repository);
const controller = new AssetController(service);

/**
 * Core Endpoints protected by your custom JWT authentication layer.
 * * - POST /assets: Creates base asset metadata and attaches an initial valuation point within a strict transaction block.
 * - GET /assets/summary: Pulls active assets linked to req.user.id alongside their most recent market snapshot value.
 * - POST /assets/:id/valuations: Appends a historical milestone value change point for net worth asset balancing charts.
 */
router.post('/', authenticate, controller.createAsset);
router.get('/history', authenticate, controller.getHistory);
router.get('/summary', authenticate, controller.getAssetsSummary);
router.post('/:id/valuations', authenticate, controller.updateValuation);

module.exports = router;