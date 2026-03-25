const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listPaymentReceipts,
  getPaymentReceiptById,
  deletePaymentReceipt,
} = require("../controllers/paymentReceiptController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listPaymentReceipts);
router.get("/:id", getPaymentReceiptById);
router.delete("/:id", deletePaymentReceipt);

module.exports = router;
