const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireSubscriptionFeature } = require("../middlewares/subscriptionGatingMiddleware");
const { getDashboardSummary } = require("../controllers/dashboardController");
const { getAnalytics } = require("../controllers/analyticsController");

const router = express.Router();

router.use(authMiddleware);

router.get("/summary", getDashboardSummary);
router.get("/analytics", requireSubscriptionFeature("ANALYTICS"), getAnalytics);

module.exports = router;
