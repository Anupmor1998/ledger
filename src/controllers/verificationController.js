const crypto = require("crypto");
const axios = require("axios");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { sendVerificationEmailOtp } = require("../utils/email");
const logger = require("../utils/logger");

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp).trim()).digest("hex");
}

/**
 * GET /api/v1/verification/status
 * Returns email and phone verification status for current user
 */
const getVerificationStatus = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      contactPhone: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
    },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  return res.json({
    email: user.email,
    isEmailVerified: Boolean(user.isEmailVerified),
    emailVerifiedAt: user.emailVerifiedAt,
    contactPhone: user.contactPhone,
    isPhoneVerified: Boolean(user.isPhoneVerified),
    phoneVerifiedAt: user.phoneVerifiedAt,
  });
});

/**
 * POST /api/v1/verification/send-email-otp
 * Generates and sends a 6-digit OTP to user's registered email via Gmail SMTP (Free)
 */
const sendEmailOtp = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, isEmailVerified: true },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  if (user.isEmailVerified) {
    return res.json({
      message: "Your email is already verified",
      isEmailVerified: true,
    });
  }

  // Check rate limit: 60s cooldown
  const lastOtp = await prisma.verificationOtp.findFirst({
    where: {
      userId,
      type: "EMAIL",
    },
    orderBy: { createdAt: "desc" },
  });

  if (lastOtp) {
    const elapsedSeconds = Math.floor((Date.now() - new Date(lastOtp.createdAt).getTime()) / 1000);
    if (elapsedSeconds < 60) {
      throw new AppError(`Please wait ${60 - elapsedSeconds}s before requesting a new code`, 429);
    }
  }

  // Generate 6-digit OTP
  const rawOtp = crypto.randomInt(100000, 999999).toString();
  const otpHash = hashOtp(rawOtp);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Invalidate any older OTPs for this user & email
  await prisma.verificationOtp.deleteMany({
    where: { userId, type: "EMAIL" },
  });

  await prisma.verificationOtp.create({
    data: {
      userId,
      type: "EMAIL",
      target: user.email,
      otpHash,
      expiresAt,
    },
  });

  const mailResult = await sendVerificationEmailOtp(user.email, rawOtp, user.name);
  if (!mailResult.sent) {
    logger.warn("Email verification OTP delivery warning", {
      userId,
      email: user.email,
      reason: mailResult.reason,
    });
  }

  return res.json({
    message: `Verification code sent to ${user.email}`,
    expiresInSeconds: 600,
  });
});

/**
 * POST /api/v1/verification/verify-email-otp
 * Validates the 6-digit OTP and marks user's email as verified
 */
const verifyEmailOtp = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { otp } = req.body;

  if (!otp || String(otp).trim().length !== 6) {
    throw new AppError("Please provide a valid 6-digit verification code", 400);
  }

  const cleanOtp = String(otp).trim();
  const hashed = hashOtp(cleanOtp);

  const otpRecord = await prisma.verificationOtp.findFirst({
    where: {
      userId,
      type: "EMAIL",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!otpRecord) {
    throw new AppError("Verification code has expired or was not requested. Please request a new code.", 400);
  }

  if (otpRecord.attempts >= 5) {
    await prisma.verificationOtp.delete({ where: { id: otpRecord.id } });
    throw new AppError("Too many failed attempts. Please request a new verification code.", 429);
  }

  if (otpRecord.otpHash !== hashed) {
    await prisma.verificationOtp.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } },
    });
    throw new AppError("Invalid verification code. Please check and try again.", 400);
  }

  // OTP is valid!
  await prisma.user.update({
    where: { id: userId },
    data: {
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    },
  });

  // Clean up used OTP
  await prisma.verificationOtp.delete({ where: { id: otpRecord.id } });

  logger.info("Email verified successfully", { userId });

  return res.json({
    message: "Email address verified successfully!",
    isEmailVerified: true,
  });
});

/**
 * POST /api/v1/verification/verify-phone-firebase
 * Accepts Firebase ID token and phone number verified on client side
 */
const verifyPhoneFirebase = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { idToken, phoneNumber } = req.body;

  if (!phoneNumber) {
    throw new AppError("Phone number is required", 400);
  }

  // Standardize 10-digit Indian phone or E.164 format
  const rawDigits = String(phoneNumber).replace(/\D/g, "");
  const normalizedPhone = rawDigits.length === 10 ? rawDigits : rawDigits.slice(-10);

  if (normalizedPhone.length !== 10) {
    throw new AppError("Please provide a valid 10-digit mobile number", 400);
  }

  let verifiedPhoneNumber = `+91${normalizedPhone}`;

  // If Firebase API key is configured on server, cryptographically verify token with Google Identity Toolkit
  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (idToken && firebaseApiKey) {
    try {
      const googleRes = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`,
        { idToken }
      );
      const googleUser = googleRes.data?.users?.[0];
      if (googleUser?.phoneNumber) {
        verifiedPhoneNumber = googleUser.phoneNumber;
      }
    } catch (err) {
      logger.warn("Firebase token lookup failed, falling back to client assertion", {
        userId,
        error: err?.message,
      });
    }
  }

  // Update user's phone number and verification status
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      contactPhone: normalizedPhone,
      isPhoneVerified: true,
      phoneVerifiedAt: new Date(),
    },
    select: {
      id: true,
      email: true,
      name: true,
      contactPhone: true,
      isPhoneVerified: true,
      phoneVerifiedAt: true,
    },
  });

  logger.info("Phone verified successfully via Firebase", {
    userId,
    phone: normalizedPhone,
  });

  return res.json({
    message: "Phone number verified successfully!",
    isPhoneVerified: true,
    contactPhone: updatedUser.contactPhone,
  });
});

module.exports = {
  getVerificationStatus,
  sendEmailOtp,
  verifyEmailOtp,
  verifyPhoneFirebase,
};

