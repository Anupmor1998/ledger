const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getSubscriptionStatus,
  previewSubscriptionOrder,
  createSubscriptionOrder,
  verifySubscriptionPayment,
  handleRazorpayWebhook,
  failSubscriptionOrder,
  getSubscriptionInvoices,
  downloadSubscriptionInvoice,
  getInAppReminders,
  testSwitchPlan,
} = require("../controllers/subscriptionController");

const router = express.Router();

// Public webhook route (called directly by Razorpay servers without user JWT)
router.post("/webhook", handleRazorpayWebhook);

// Protected routes (require user authentication)
router.use(authMiddleware);

router.get("/status", getSubscriptionStatus);
router.get("/reminders", getInAppReminders);
router.post("/test-switch-plan", testSwitchPlan);
router.post("/preview", previewSubscriptionOrder);
router.post("/create-order", createSubscriptionOrder);
router.post("/verify-payment", verifySubscriptionPayment);
router.post("/fail-order", failSubscriptionOrder);
router.get("/invoices", getSubscriptionInvoices);
router.get("/invoices/:id/download", downloadSubscriptionInvoice);
router.get("/receipts", getSubscriptionInvoices);
router.get("/receipts/:id/download", downloadSubscriptionInvoice);

module.exports = router;
