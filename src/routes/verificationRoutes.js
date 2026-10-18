const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getVerificationStatus,
  sendEmailOtp,
  verifyEmailOtp,
  verifyPhoneFirebase,
} = require("../controllers/verificationController");

const router = express.Router();

// All verification routes require authentication
router.use(authMiddleware);

router.get("/status", getVerificationStatus);
router.post("/send-email-otp", sendEmailOtp);
router.post("/verify-email-otp", verifyEmailOtp);
router.post("/verify-phone-firebase", verifyPhoneFirebase);

module.exports = router;

