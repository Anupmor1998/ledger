const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getNextSerialNo,
  getEligibleOrders,
  createPaymentEntry,
  listPaymentEntries,
  getPaymentEntryById,
  settlePartialAccount,
  deletePaymentEntry,
} = require("../controllers/paymentEntryController");

const router = express.Router();

router.use(authMiddleware);

router.get("/next-serial", getNextSerialNo);
router.get("/orders", getEligibleOrders);
router.get("/", listPaymentEntries);
router.get("/:id", getPaymentEntryById);
router.post("/", createPaymentEntry);
router.post("/:id/settle", settlePartialAccount);
router.delete("/:id", deletePaymentEntry);

module.exports = router;
