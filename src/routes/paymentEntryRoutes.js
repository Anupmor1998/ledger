const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireActiveSubscription } = require("../middlewares/subscriptionGatingMiddleware");
const {
  getNextSerialNo,
  getEligibleOrders,
  createPaymentEntry,
  updatePaymentEntry,
  listPaymentEntries,
  getPaymentEntryById,
  settlePartialAccount,
  deletePaymentEntry,
  getManufacturerPaymentSummary,
} = require("../controllers/paymentEntryController");

const router = express.Router();

router.use(authMiddleware);

router.get("/next-serial", getNextSerialNo);
router.get("/orders", getEligibleOrders);
router.get("/manufacturer-summary/:manufacturerId", getManufacturerPaymentSummary);
router.get("/", listPaymentEntries);
router.get("/:id", getPaymentEntryById);
router.post("/", requireActiveSubscription, createPaymentEntry);
router.put("/:id", requireActiveSubscription, updatePaymentEntry);
router.post("/:id/settle", requireActiveSubscription, settlePartialAccount);
router.delete("/:id", requireActiveSubscription, deletePaymentEntry);

module.exports = router;
