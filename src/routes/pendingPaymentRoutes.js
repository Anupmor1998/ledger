const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listPendingPayments,
  createBulkPendingPaymentReceipt,
} = require("../controllers/pendingPaymentController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listPendingPayments);
router.post("/receive-bulk", createBulkPendingPaymentReceipt);

module.exports = router;
