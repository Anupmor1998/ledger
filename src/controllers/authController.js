const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const { createToken } = require("../utils/jwt");

const SALT_ROUNDS = 10;

async function signup(req, res) {
  const { email, name, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  if (password.length < 8) {
    return res.status(400).json({ message: "password must be at least 8 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: { email, name, password: passwordHash },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    const token = createToken(user);
    return res.status(201).json({ user, token });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "email already exists" });
    }
    return res.status(500).json({ message: "failed to sign up", detail: error.message });
  }
}

async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ message: "invalid credentials" });
    }

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({ message: "invalid credentials" });
    }

    const token = createToken(user);
    return res.json({
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      token,
    });
  } catch (error) {
    return res.status(500).json({ message: "failed to login", detail: error.message });
  }
}

async function forgotPassword(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "email is required" });
  }

  const genericMessage = { message: "if this email is registered, a reset token has been generated" };

  try {
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
  } catch (error) {
    return res.status(500).json({ message: "failed to generate reset token", detail: error.message });
  }
}

async function resetPassword(req, res) {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ message: "token and newPassword are required" });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: "newPassword must be at least 8 characters" });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
    });

    if (!resetRecord || resetRecord.usedAt || resetRecord.expiresAt < new Date()) {
      return res.status(400).json({ message: "invalid or expired token" });
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
  } catch (error) {
    return res.status(500).json({ message: "failed to reset password", detail: error.message });
  }
}

module.exports = {
  signup,
  login,
  forgotPassword,
  resetPassword,
};
