// routes/contact.routes.js
const { Router } = require("express");
const { publicLimiter } = require("../../middleware/rateLimiter.middleware");
const contactController = require("./contact.controller.js");

const router = Router();

// POST /api/contact - Matches client utility calls: api.post("/contact", form)
router.post("/", publicLimiter, contactController.submitContact);

module.exports = router