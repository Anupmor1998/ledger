const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createPaymentReceipt,
  listPaymentReceipts,
  getPaymentReceiptById,
  updatePaymentReceipt,
  deletePaymentReceipt,
} = require("../controllers/paymentReceiptController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", createPaymentReceipt);
router.get("/", listPaymentReceipts);
router.get("/:id", getPaymentReceiptById);
router.put("/:id", updatePaymentReceipt);
router.delete("/:id", deletePaymentReceipt);

module.exports = router;
