const crypto = require("crypto");
const Razorpay = require("razorpay");
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = require("./env");
const logger = require("../utils/logger");

let razorpayInstance = null;

if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  try {
    razorpayInstance = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
    logger.info("Razorpay SDK initialized", { feature: "subscription" });
  } catch (err) {
    logger.error("Failed to initialize Razorpay SDK", {
      feature: "subscription",
      error: err,
    });
  }
} else {
  logger.warn("Razorpay keys missing in .env. Subscription payments will require RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET", {
    feature: "subscription",
  });
}

function getRazorpayInstance() {
  if (!razorpayInstance && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
    razorpayInstance = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayInstance;
}

/**
 * Verify cryptographic HMAC-SHA256 signature returned by Razorpay Standard Checkout
 */
function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  if (!RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay key secret not configured on server");
  }

  const generatedSignature = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  return generatedSignature === signature;
}

/**
 * Verify cryptographic HMAC-SHA256 signature sent in Razorpay Webhooks
 */
function verifyRazorpayWebhookSignature({ rawBody, signature, secret }) {
  const webhookSecret = secret || RAZORPAY_WEBHOOK_SECRET || RAZORPAY_KEY_SECRET;
  if (!webhookSecret) {
    throw new Error("Razorpay webhook secret not configured on server");
  }

  return Razorpay.validateWebhookSignature(rawBody, signature, webhookSecret);
}

module.exports = {
  getRazorpayInstance,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
};
