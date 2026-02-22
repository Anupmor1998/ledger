const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  exportOrderRegisterReport,
  exportOrderProgressReport,
  exportCompletedSettlementReport,
  exportCancelledOrdersReport,
  exportManufacturerCommissionReport,
} = require("../controllers/reportController");

const router = express.Router();

router.use(authMiddleware);

router.get("/order-register.xlsx", exportOrderRegisterReport);
router.get("/order-progress.xlsx", exportOrderProgressReport);
router.get("/completed-settlement.xlsx", exportCompletedSettlementReport);
router.get("/cancelled-orders.xlsx", exportCancelledOrdersReport);
router.get("/manufacturer-commission.xlsx", exportManufacturerCommissionReport);

module.exports = router;
