const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getMyReferralInfo,
  validateReferralCode,
} = require("../controllers/referralController");

const router = express.Router();

// Public: validate referral code for signup
router.get("/validate/:code", validateReferralCode);

// Protected: get user referral dashboard data & stats
router.get("/me", authMiddleware, getMyReferralInfo);

module.exports = router;
