const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const { FRONTEND_URL } = require("../config/env");
const { createToken } = require("../utils/jwt");
const { sendPasswordResetEmail, EMAIL_TRANSPORT_READY, IS_DEVELOPMENT } = require("../utils/email");
const logger = require("../utils/logger");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { getFinancialYearStartYear } = require("../utils/financialYear");
const { generateCandidateCode } = require("../utils/referralCode");

const SALT_ROUNDS = 10;

function buildSessionUser(user) {
  const isVip =
    user.subscriptionPlan === "COMPLIMENTARY" ||
    (user.subscriptionPlan === "PREMIUM" && user.billingCycle === "LIFETIME") ||
    (user.subscriptionPlan === "PREMIUM" && !user.planExpiresAt);

  const now = new Date();
  let isExpired = false;
  if (!isVip && user.role !== "ADMIN") {
    if ((user.subscriptionPlan === "TRIAL" || !user.subscriptionPlan) && user.trialEndsAt) {
      isExpired = new Date(user.trialEndsAt).getTime() <= now.getTime();
    } else if (user.planExpiresAt) {
      isExpired = new Date(user.planExpiresAt).getTime() <= now.getTime();
    }
  }

  const resolvedSubscriptionStatus = isExpired
    ? "EXPIRED"
    : user.subscriptionStatus || "ACTIVE";

  if (isExpired && user.subscriptionStatus === "ACTIVE" && user.id) {
    prisma.user
      .update({
        where: { id: user.id },
        data: { subscriptionStatus: "EXPIRED" },
      })
      .catch(() => {});
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    theme: user.theme,
    selectedFinancialYearStart: user.selectedFinancialYearStart ?? getFinancialYearStartYear(),
    firmName: user.firmName || null,
    businessSubtitle: user.businessSubtitle || null,
    contactPhone: user.contactPhone || null,
    businessAddress: user.businessAddress || null,
    isEmailVerified: Boolean(user.isEmailVerified),
    isPhoneVerified: Boolean(user.isPhoneVerified),
    emailVerifiedAt: user.emailVerifiedAt || null,
    phoneVerifiedAt: user.phoneVerifiedAt || null,
    subscriptionPlan:
      user.subscriptionPlan === "COMPLIMENTARY" ? "PREMIUM" : (user.subscriptionPlan || "TRIAL"),
    billingCycle:
      user.subscriptionPlan === "COMPLIMENTARY" || (user.subscriptionPlan === "PREMIUM" && !user.planExpiresAt)
        ? "YEARLY"
        : (user.billingCycle || "MONTHLY"),
    isComplimentary: false,
    subscriptionStatus: resolvedSubscriptionStatus,
    trialEndsAt: user.trialEndsAt || null,
    planExpiresAt:
      user.subscriptionPlan === "COMPLIMENTARY" || (user.subscriptionPlan === "PREMIUM" && !user.planExpiresAt)
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        : (user.planExpiresAt || null),
    referralCode: user.referralCode || null,
    createdAt: user.createdAt,
  };
}

function buildResetPasswordUrl(token) {
  if (!FRONTEND_URL) {
    return null;
  }

  const baseUrl = FRONTEND_URL.endsWith("/") ? FRONTEND_URL.slice(0, -1) : FRONTEND_URL;
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

function maskEmail(email) {
  const [name = "", domain = ""] = String(email || "").split("@");
  if (!name || !domain) {
    return "unknown";
  }
  return `${name.slice(0, 2)}***@${domain}`;
}

const signup = asyncHandler(async (req, res) => {
  const { email, name, password, contactPhone, referralCode } = req.body;

  if (!email || !password) {
    throw new AppError("Email and password are required", 400);
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  if (password.length < 8) {
    throw new AppError("Password must be at least 8 characters", 400);
  }

  // Validate phone number
  let cleanPhone = null;
  if (contactPhone) {
    const digits = String(contactPhone).replace(/\D/g, "");
    if (digits.length < 10) {
      throw new AppError("Please enter a valid 10-digit mobile number", 400);
    }
    cleanPhone = digits.slice(-10);
  } else {
    throw new AppError("Mobile phone number is required for signup", 400);
  }

  // 1. Check if email is already registered
  const existingUserByEmail = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existingUserByEmail) {
    throw new AppError("An account with this email already exists. Please log in instead.", 409);
  }

  // 2. Check if mobile number is already registered to another account
  const existingUserByPhone = await prisma.user.findFirst({
    where: { contactPhone: cleanPhone },
    select: { id: true },
  });
  if (existingUserByPhone) {
    throw new AppError("This mobile number is already registered with another account. Each account must have a unique mobile number.", 409);
  }

  // 3. Process referral code if provided
  let referrerUser = null;
  let trialDays = 14;

  if (referralCode && typeof referralCode === "string" && referralCode.trim()) {
    const cleanRefCode = referralCode.trim().toUpperCase();
    const candidateReferrer = await prisma.user.findUnique({
      where: { referralCode: cleanRefCode },
      select: {
        id: true,
        email: true,
        contactPhone: true,
      },
    });

    if (candidateReferrer) {
      const isSelf =
        candidateReferrer.email === normalizedEmail ||
        (cleanPhone && candidateReferrer.contactPhone === cleanPhone);

      if (!isSelf) {
        referrerUser = candidateReferrer;
        trialDays = 29; // Standard 14 days + 15 referral bonus days
      }
    }
  }

  // 4. Generate unique referral code for the new user
  let newUserReferralCode = null;
  let attempts = 0;
  while (!newUserReferralCode && attempts < 10) {
    attempts++;
    const testCode = generateCandidateCode(name);
    const codeTaken = await prisma.user.findUnique({
      where: { referralCode: testCode },
      select: { id: true },
    });
    if (!codeTaken) {
      newUserReferralCode = testCode;
    }
  }
  if (!newUserReferralCode) {
    newUserReferralCode = `SB${Date.now().toString(36).toUpperCase().slice(-6)}`;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name,
      contactPhone: cleanPhone,
      password: passwordHash,
      role: "USER",
      selectedFinancialYearStart: getFinancialYearStartYear(),
      trialEndsAt,
      isEmailVerified: false,
      isPhoneVerified: false,
      referralCode: newUserReferralCode,
      referredById: referrerUser ? referrerUser.id : null,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      theme: true,
      selectedFinancialYearStart: true,
      firmName: true,
      businessSubtitle: true,
      contactPhone: true,
      businessAddress: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      subscriptionPlan: true,
      billingCycle: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      planExpiresAt: true,
      referralCode: true,
      createdAt: true,
    },
  });

  // If referred, create initial ReferralRecord
  if (referrerUser) {
    await prisma.referralRecord.create({
      data: {
        referrerId: referrerUser.id,
        refereeId: user.id,
        status: "REGISTERED",
        rewardDays: 15,
        rewardGranted: false,
      },
    });
  }

  const token = createToken(user);
  return res.status(201).json({
    user: buildSessionUser(user),
    token,
    referralApplied: Boolean(referrerUser),
    trialDays,
  });
});

const createAdminAccount = asyncHandler(async (req, res) => {
  const { email, name, password } = req.body || {};

  if (!email || !password) {
    throw new AppError("email and password are required", 400);
  }

  if (String(password).length < 8) {
    throw new AppError("password must be at least 8 characters", 400);
  }

  const passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await prisma.user.upsert({
    where: { email: normalizedEmail },
    create: {
      email: normalizedEmail,
      name: String(name || "").trim() || null,
      password: passwordHash,
      role: "ADMIN",
      selectedFinancialYearStart: getFinancialYearStartYear(),
    },
    update: {
      name: String(name || "").trim() || null,
      password: passwordHash,
      role: "ADMIN",
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      theme: true,
      selectedFinancialYearStart: true,
      firmName: true,
      businessSubtitle: true,
      contactPhone: true,
      businessAddress: true,
      createdAt: true,
    },
  });

  const token = createToken(user);
  return res.status(201).json({ user: buildSessionUser(user), token });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError("email and password are required", 400);
  }

  let user;
  try {
    user = await prisma.user.findUnique({ where: { email } });
  } catch (_err) {
    user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        name: true,
        role: true,
        theme: true,
        selectedFinancialYearStart: true,
        firmName: true,
        businessSubtitle: true,
        contactPhone: true,
        businessAddress: true,
        createdAt: true,
      },
    });
  }

  if (!user) {
    throw new AppError("invalid credentials", 401);
  }

  const isValid = await bcrypt.compare(password, user.password);

  if (!isValid) {
    throw new AppError("invalid credentials", 401);
  }

  // If user is on TRIAL and trialEndsAt is not set (e.g. account created before the pricing module),
  // start their fresh 14-day trial upon this login and save it to the database:
  if (
    user.role !== "ADMIN" &&
    (user.subscriptionPlan === "TRIAL" || !user.subscriptionPlan) &&
    !user.trialEndsAt &&
    !user.planExpiresAt
  ) {
    const freshTrialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { trialEndsAt: freshTrialEnd },
      });
      user.trialEndsAt = freshTrialEnd;
    } catch (_err) {
      // Safe fallback
    }
  }

  const token = createToken(user);
  return res.json({
    user: buildSessionUser(user),
    token,
  });
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new AppError("email is required", 400);
  }

  const genericMessage = { message: "if this email is registered, a reset token has been generated" };
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    logger.info("Password reset requested for unknown email", {
      feature: "forgot-password",
      email: maskEmail(email),
    });
    return res.json(genericMessage);
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 15);

  await prisma.passwordResetToken.create({
    data: {
      token: tokenHash,
      userId: user.id,
      expiresAt,
    },
  });

  const resetPasswordUrl = buildResetPasswordUrl(rawToken);
  const emailResult = await sendPasswordResetEmail(user.email, resetPasswordUrl);

  if (emailResult.sent) {
    logger.info("Password reset email sent", {
      feature: "forgot-password",
      userId: user.id,
      email: maskEmail(user.email),
    });
    return res.json({
      message: "if this email is registered, a reset email has been sent",
    });
  }

  logger.warn("Password reset email not sent", {
    feature: "forgot-password",
    userId: user.id,
    email: maskEmail(user.email),
    frontendUrlConfigured: Boolean(FRONTEND_URL),
    smtpConfigured: EMAIL_TRANSPORT_READY,
    reason: emailResult.reason,
    environment: IS_DEVELOPMENT ? "development" : "production",
  });

  if (!IS_DEVELOPMENT) {
    return res.json({
      message: "if this email is registered, a reset request has been recorded",
    });
  }

  return res.json({
    ...genericMessage,
    resetToken: rawToken,
    note: !EMAIL_TRANSPORT_READY
      ? "Set GMAIL_SMTP_EMAIL and GMAIL_SMTP_APP_PASSWORD in env to enable Gmail delivery."
      : !resetPasswordUrl
      ? "Set FRONTEND_URL in env to generate reset links. Returning token for development fallback."
      : "reset email could not be sent, returning token for development fallback",
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    throw new AppError("token and newPassword are required", 400);
  }

  if (newPassword.length < 8) {
    throw new AppError("newPassword must be at least 8 characters", 400);
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const resetRecord = await prisma.passwordResetToken.findUnique({
    where: { token: tokenHash },
  });

  if (!resetRecord || resetRecord.usedAt || resetRecord.expiresAt < new Date()) {
    throw new AppError("invalid or expired token", 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetRecord.userId },
      data: { password: passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetRecord.id },
      data: { usedAt: new Date() },
    }),
  ]);

  logger.info("Password reset completed", {
    feature: "reset-password",
    userId: resetRecord.userId,
  });

  return res.json({ message: "password reset successful" });
});

module.exports = {
  signup,
  createAdminAccount,
  login,
  forgotPassword,
  resetPassword,
};
