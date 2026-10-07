const crypto = require("crypto");
const Razorpay = require("razorpay");
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = require("./env");
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

module.exports = {
  getRazorpayInstance,
  verifyRazorpaySignature,
  RAZORPAY_KEY_ID,
};
