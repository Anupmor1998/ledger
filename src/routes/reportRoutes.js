const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
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

router.get("/order-report.xlsx", exportOrderReport);
router.get("/customer-report.xlsx", exportCustomerReport);
router.get("/manufacturer-report.xlsx", exportManufacturerReport);
router.get("/order-report.pdf", exportOrderReportPdf);
router.get("/customer-report.pdf", exportCustomerReportPdf);
router.get("/manufacturer-report.pdf", exportManufacturerReportPdf);

module.exports = router;
