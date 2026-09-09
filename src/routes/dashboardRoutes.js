const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { getDashboardSummary } = require("../controllers/dashboardController");
const { getAnalytics } = require("../controllers/analyticsController");

const router = express.Router();

router.use(authMiddleware);

router.get("/summary", getDashboardSummary);
router.get("/analytics", getAnalytics);

module.exports = router;
