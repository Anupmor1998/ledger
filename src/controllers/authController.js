const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const { createToken } = require("../utils/jwt");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

const SALT_ROUNDS = 10;

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
    data: { email, name, password: passwordHash },
    select: { id: true, email: true, name: true, theme: true, createdAt: true },
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

  return res.json({
    ...genericMessage,
    resetToken: rawToken,
    note: "for development only; in production this token should be sent via email",
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

  return res.json({ message: "password reset successful" });
});

module.exports = {
  signup,
  login,
  forgotPassword,
  resetPassword,
};
