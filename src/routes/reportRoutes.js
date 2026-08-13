const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  exportOrderReport,
  exportCustomerReport,
  exportManufacturerReport,
} = require("../controllers/reportController");

const router = express.Router();

router.use(authMiddleware);

router.get("/order-report.xlsx", exportOrderReport);
router.get("/customer-report.xlsx", exportCustomerReport);
router.get("/manufacturer-report.xlsx", exportManufacturerReport);

module.exports = router;
