const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  requireActiveSubscription,
  requireSubscriptionFeature,
} = require("../middlewares/subscriptionGatingMiddleware");
const {
  exportOrderReport,
  exportCustomerReport,
  exportManufacturerReport,
  exportOrderReportPdf,
  exportCustomerReportPdf,
  exportManufacturerReportPdf,
  createReportShareLink,
  exportSharedReportPdf,
} = require("../controllers/reportController");

const router = express.Router();

// Public route: parties can view and download the shared branded PDF without logging in
router.get("/shared/:shareToken", exportSharedReportPdf);

// All routes below require authentication
router.use(authMiddleware);

router.post("/share-link", requireSubscriptionFeature("PDF_EXPORT"), createReportShareLink);
router.get("/order-report.xlsx", requireActiveSubscription, exportOrderReport);
router.get("/customer-report.xlsx", requireActiveSubscription, exportCustomerReport);
router.get("/manufacturer-report.xlsx", requireActiveSubscription, exportManufacturerReport);
router.get("/order-report.pdf", requireSubscriptionFeature("PDF_EXPORT"), exportOrderReportPdf);
router.get("/customer-report.pdf", requireSubscriptionFeature("PDF_EXPORT"), exportCustomerReportPdf);
router.get("/manufacturer-report.pdf", requireSubscriptionFeature("PDF_EXPORT"), exportManufacturerReportPdf);

module.exports = router;
