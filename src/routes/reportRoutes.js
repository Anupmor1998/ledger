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
} = require("../controllers/reportController");

const router = express.Router();

router.use(authMiddleware);

router.get("/order-report.xlsx", requireActiveSubscription, exportOrderReport);
router.get("/customer-report.xlsx", requireActiveSubscription, exportCustomerReport);
router.get("/manufacturer-report.xlsx", requireActiveSubscription, exportManufacturerReport);
router.get("/order-report.pdf", requireSubscriptionFeature("PDF_EXPORT"), exportOrderReportPdf);
router.get("/customer-report.pdf", requireSubscriptionFeature("PDF_EXPORT"), exportCustomerReportPdf);
router.get("/manufacturer-report.pdf", requireSubscriptionFeature("PDF_EXPORT"), exportManufacturerReportPdf);

module.exports = router;
