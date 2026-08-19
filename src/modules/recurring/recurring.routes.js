// recurring.routes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('./recurring.controller');
const { authenticate } = require('../../middleware/authorize.middleware');

router.use(authenticate);

router.post('/detect',   ctrl.detect);    // run detection
router.get('/upcoming',  ctrl.upcoming);  // upcoming bills card

module.exports = router;