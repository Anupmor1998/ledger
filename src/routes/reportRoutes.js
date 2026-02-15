const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  exportOrdersReport,
  exportDateRangeSummaryReport,
  exportCustomerReport,
  exportManufacturerReport,
  exportQualityReport,
  exportUserActivityReport,
  exportGstSummaryReport,
  exportRecentOrdersReport,
  exportTopCustomersReport,
  exportTopManufacturersReport,
  exportLedgerReport,
} = require("../controllers/reportController");

const router = express.Router();

router.use(authMiddleware);

router.get("/orders.xlsx", exportOrdersReport);
router.get("/date-range.xlsx", exportDateRangeSummaryReport);
router.get("/customers.xlsx", exportCustomerReport);
router.get("/manufacturers.xlsx", exportManufacturerReport);
router.get("/qualities.xlsx", exportQualityReport);
router.get("/users.xlsx", exportUserActivityReport);
router.get("/gst-summary.xlsx", exportGstSummaryReport);
router.get("/recent-orders.xlsx", exportRecentOrdersReport);
router.get("/top-customers.xlsx", exportTopCustomersReport);
router.get("/top-manufacturers.xlsx", exportTopManufacturersReport);
router.get("/ledger.xlsx", exportLedgerReport);

module.exports = router;
