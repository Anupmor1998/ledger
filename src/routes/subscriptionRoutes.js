const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getSubscriptionStatus,
  previewSubscriptionOrder,
  createSubscriptionOrder,
  verifySubscriptionPayment,
  getSubscriptionInvoices,
} = require("../controllers/subscriptionController");

const router = express.Router();

router.use(authMiddleware);

router.get("/status", getSubscriptionStatus);
router.post("/preview", previewSubscriptionOrder);
router.post("/create-order", createSubscriptionOrder);
router.post("/verify-payment", verifySubscriptionPayment);
router.get("/invoices", getSubscriptionInvoices);

module.exports = router;
