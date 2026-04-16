const express = require('express');
const router = express.Router();

// Import packages route
const packagesRouter = require('./packages');

// Mount routes
router.use('/packages', packagesRouter);

module.exports = router;
