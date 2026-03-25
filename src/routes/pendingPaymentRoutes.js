const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listPendingPayments,
  receivePendingPayment,
} = require("../controllers/pendingPaymentController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listPendingPayments);
router.post("/:id/receive", receivePendingPayment);

module.exports = router;
