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

const SALT_ROUNDS = 10;

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
  const { email, name, password } = req.body;

  if (!email || !password) {
    throw new AppError("email and password are required", 400);
  }

  if (password.length < 8) {
    throw new AppError("password must be at least 8 characters", 400);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      password: passwordHash,
      selectedFinancialYearStart: getFinancialYearStartYear(),
    },
    select: {
      id: true,
      email: true,
      name: true,
      theme: true,
      selectedFinancialYearStart: true,
      createdAt: true,
    },
  });

  const token = createToken(user);
  return res.status(201).json({ user, token });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError("email and password are required", 400);
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    throw new AppError("invalid credentials", 401);
  }

  const isValid = await bcrypt.compare(password, user.password);

  if (!isValid) {
    throw new AppError("invalid credentials", 401);
  }

  const token = createToken(user);
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      theme: user.theme,
      selectedFinancialYearStart:
        user.selectedFinancialYearStart ?? getFinancialYearStartYear(),
      createdAt: user.createdAt,
    },
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
  login,
  forgotPassword,
  resetPassword,
};
