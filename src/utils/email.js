const nodemailer = require("nodemailer");
const {
  NODE_ENV,
  GMAIL_SMTP_EMAIL,
  GMAIL_SMTP_APP_PASSWORD,
  PASSWORD_RESET_FROM_EMAIL,
} = require("../config/env");
const logger = require("./logger");

const EMAIL_TRANSPORT_READY = Boolean(GMAIL_SMTP_EMAIL && GMAIL_SMTP_APP_PASSWORD);
const IS_DEVELOPMENT = NODE_ENV !== "production";

let cachedTransporter = null;

function getTransporter() {
  if (!EMAIL_TRANSPORT_READY) {
    return null;
  }

  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_SMTP_EMAIL,
        pass: GMAIL_SMTP_APP_PASSWORD,
      },
    });
  }

  return cachedTransporter;
}

async function sendPasswordResetEmail(to, resetUrl) {
  const transporter = getTransporter();
  if (!transporter || !to || !resetUrl) {
    return {
      sent: false,
      reason: !to
        ? "missing-recipient"
        : !resetUrl
        ? "missing-reset-url"
        : "smtp-not-configured",
    };
  }

  try {
    await transporter.sendMail({
      from: PASSWORD_RESET_FROM_EMAIL || GMAIL_SMTP_EMAIL,
      to,
      subject: "Ledger Password Reset",
      html: `
        <p>You requested a password reset for your Ledger account.</p>
        <p>
          <a href="${resetUrl}" target="_blank" rel="noopener noreferrer">
            Reset your password
          </a>
        </p>
        <p>This link expires in 15 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    });

    return { sent: true, reason: null };
  } catch (error) {
    logger.error("Password reset email send failed", {
      feature: "forgot-password",
      to,
      reason: "smtp-send-failed",
      error,
    });
    return {
      sent: false,
      reason: "smtp-send-failed",
    };
  }
}

module.exports = {
  sendPasswordResetEmail,
  EMAIL_TRANSPORT_READY,
  IS_DEVELOPMENT,
};
