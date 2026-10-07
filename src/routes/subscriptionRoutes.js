const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getSubscriptionStatus,
  previewSubscriptionOrder,
  createSubscriptionOrder,
  verifySubscriptionPayment,
  failSubscriptionOrder,
  getSubscriptionInvoices,
  downloadSubscriptionInvoice,
} = require("../controllers/subscriptionController");

const router = express.Router();

router.use(authMiddleware);

router.get("/status", getSubscriptionStatus);
router.post("/preview", previewSubscriptionOrder);
router.post("/create-order", createSubscriptionOrder);
router.post("/verify-payment", verifySubscriptionPayment);
router.post("/fail-order", failSubscriptionOrder);
router.get("/invoices", getSubscriptionInvoices);
router.get("/invoices/:id/download", downloadSubscriptionInvoice);

module.exports = router;
