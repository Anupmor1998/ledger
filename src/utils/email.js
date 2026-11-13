const nodemailer = require("nodemailer");
const {
  NODE_ENV,
  FRONTEND_URL,
  GMAIL_SMTP_EMAIL,
  GMAIL_SMTP_APP_PASSWORD,
  PASSWORD_RESET_FROM_EMAIL,
} = require("../config/env");
const logger = require("./logger");

const EMAIL_TRANSPORT_READY = Boolean(
  GMAIL_SMTP_EMAIL && GMAIL_SMTP_APP_PASSWORD,
);
const IS_DEVELOPMENT = NODE_ENV !== "production";

const cleanUser = String(GMAIL_SMTP_EMAIL || "").trim();
const cleanPass = String(GMAIL_SMTP_APP_PASSWORD || "").trim().replace(/^["']|["']$/g, "");

function createTransporter(port = 587, secure = false) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : secure,
    auth: {
      user: cleanUser,
      pass: cleanPass,
    },
    family: 4, // Strictly force IPv4 to avoid IPv6 hanging on cloud hosts
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

let primaryTransporter = null;
let fallbackTransporter = null;

function getTransporters() {
  if (!EMAIL_TRANSPORT_READY) return null;
  if (!primaryTransporter) {
    primaryTransporter = createTransporter(587, false);
    fallbackTransporter = createTransporter(465, true);
  }
  return { primaryTransporter, fallbackTransporter };
}

function getTransporter() {
  const t = getTransporters();
  return t ? t.primaryTransporter : null;
}

async function sendMailWithFailover(mailOptions) {
  const transporters = getTransporters();
  if (!transporters) {
    throw new Error("smtp-not-configured");
  }

  try {
    return await transporters.primaryTransporter.sendMail(mailOptions);
  } catch (primaryErr) {
    logger.warn("Primary SMTP on port 587 failed, attempting fallback on port 465", {
      error: primaryErr.message,
    });
    return await transporters.fallbackTransporter.sendMail(mailOptions);
  }
}


const BREVO_API_KEY = process.env.BREVO_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

/**
 * Universal email sender that routes over HTTPS Port 443 (Brevo / Resend)
 * to bypass Render.com's outbound SMTP port blocking (ports 25, 465, 587).
 * Falls back to Nodemailer SMTP on local/paid servers.
 */
async function sendUniversalEmail({ to, subject, html, text, name }) {
  const cleanTo = String(to || "").trim().toLowerCase();
  const cleanFromEmail = String(GMAIL_SMTP_EMAIL || PASSWORD_RESET_FROM_EMAIL || "saudabook2026@gmail.com").trim();

  // 1. Brevo REST API (HTTPS Port 443 - 300 free emails/day, immune to Render SMTP block)
  if (process.env.BREVO_API_KEY) {
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        signal: AbortSignal.timeout(6000), // 6s fast failover timeout
        headers: {
          "api-key": process.env.BREVO_API_KEY.trim(),
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: "Sauda Book", email: cleanFromEmail },
          to: [{ email: cleanTo, name: name || "Broker / Partner" }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Brevo HTTP error ${res.status}`);
      }
      logger.info("Email delivered via Brevo HTTPS API", { to: cleanTo, messageId: data.messageId });
      return { sent: true, reason: null, messageId: data.messageId };
    } catch (err) {
      logger.error("Brevo HTTPS API delivery failed", { error: err.message });
      // Fall through to next provider
    }
  }

  // 2. Resend REST API (HTTPS Port 443 - 3,000 free emails/mo)
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(6000), // 6s fast failover timeout
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || "Sauda Book <onboarding@resend.dev>",
          to: [cleanTo],
          subject,
          html,
          text,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Resend HTTP error ${res.status}`);
      }
      logger.info("Email delivered via Resend HTTPS API", { to: cleanTo, id: data.id });
      return { sent: true, reason: null, messageId: data.id };
    } catch (err) {
      logger.error("Resend HTTPS API delivery failed", { error: err.message });
      // Fall through to next provider
    }
  }

  // 3. Fallback to direct SMTP (works on local and paid cloud hosting)
  if (!EMAIL_TRANSPORT_READY) {
    return { sent: false, reason: "smtp-not-configured" };
  }

  const fromAddress = `"Sauda Book" <${cleanFromEmail}>`;
  try {
    const info = await sendMailWithFailover({
      from: fromAddress,
      to: cleanTo,
      replyTo: cleanFromEmail,
      subject,
      text,
      html,
    });
    logger.info("Email delivered via direct SMTP", { to: cleanTo, messageId: info.messageId });
    return { sent: true, reason: null, messageId: info.messageId };
  } catch (err) {
    logger.error("SMTP delivery failed", { error: err.message, to: cleanTo });
    return { sent: false, reason: err.message || "smtp-send-failed" };
  }
}

async function sendPasswordResetEmail(to, resetUrl) {
  const cleanTo = String(to || "").trim().toLowerCase();
  if (!cleanTo || !resetUrl) {
    return {
      sent: false,
      reason: !cleanTo ? "missing-recipient" : "missing-reset-url",
    };
  }

  const html = `
    <p>You requested a password reset for your Sauda Book account.</p>
    <p>
      <a href="${resetUrl}" target="_blank" rel="noopener noreferrer">
        Reset your password
      </a>
    </p>
    <p>This link expires in 15 minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  const text = `You requested a password reset for your Sauda Book account.
Reset your password: ${resetUrl}
This link expires in 15 minutes.
If you did not request this, you can ignore this email.`;

  return await sendUniversalEmail({
    to: cleanTo,
    subject: "Sauda Book Password Reset",
    html,
    text,
    name: "User",
  });
}

async function sendSupportTicketAdminAlert({ ticket, user, adminEmails }) {
  const transporter = getTransporter();
  const recipients = Array.isArray(adminEmails)
    ? adminEmails.filter(Boolean)
    : [adminEmails].filter(Boolean);

  if (!transporter || recipients.length === 0) {
    return {
      sent: false,
      reason:
        recipients.length === 0 ? "no-admin-recipients" : "smtp-not-configured",
    };
  }

  const cleanPhone = ticket.contactPhone
    ? ticket.contactPhone.replace(/\D/g, "")
    : "";
  const phoneFormatted =
    cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
  const whatsappUrl = phoneFormatted
    ? `https://wa.me/${phoneFormatted}?text=${encodeURIComponent(
        `Hi ${user.name || "there"}, regarding your Support Ticket #${ticket.ticketNo} (${ticket.subject}) on Sauda Book...`,
      )}`
    : null;

  const adminDashboardUrl = FRONTEND_URL ? `${FRONTEND_URL}/admin/support` : "";

  const priorityColor =
    ticket.priority === "URGENT"
      ? "#ef4444"
      : ticket.priority === "HIGH"
        ? "#f97316"
        : ticket.priority === "MEDIUM"
          ? "#3b82f6"
          : "#10b981";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <div style="border-bottom: 2px solid #f1f5f9; padding-bottom: 16px; margin-bottom: 20px;">
        <span style="display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; border-radius: 9999px; background-color: ${priorityColor}; color: #ffffff;">
          ${ticket.priority} PRIORITY
        </span>
        <span style="display: inline-block; margin-left: 8px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 9999px; background-color: #f1f5f9; color: #475569;">
          Ticket #${ticket.ticketNo}
        </span>
        <h2 style="margin: 12px 0 4px 0; color: #0f172a; font-size: 20px; font-weight: 700;">
          ${escapeHtml(ticket.subject)}
        </h2>
        <p style="margin: 0; color: #64748b; font-size: 13px;">
          Category: <strong>${ticket.category}</strong> • Received: ${new Date(ticket.createdAt).toLocaleString("en-IN")}
        </p>
      </div>

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 20px; border-left: 4px solid #3b82f6;">
        <h4 style="margin: 0 0 8px 0; color: #1e293b; font-size: 14px;">User Issue Description:</h4>
        <p style="margin: 0; color: #334155; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(ticket.description)}</p>
      </div>

      <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <h4 style="margin: 0 0 12px 0; color: #0f172a; font-size: 14px;">User Contact Information:</h4>
        <table style="width: 100%; font-size: 13px; color: #334155; border-collapse: collapse;">
          <tr>
            <td style="padding: 4px 0; color: #64748b; width: 140px;">Name:</td>
            <td style="padding: 4px 0; font-weight: 600;">${escapeHtml(user.name || "N/A")}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #64748b;">Account Email:</td>
            <td style="padding: 4px 0;">${escapeHtml(user.email)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #64748b;">Phone Number:</td>
            <td style="padding: 4px 0; font-weight: 600;">${ticket.contactPhone || "Not provided"}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #64748b;">Preferred Channel:</td>
            <td style="padding: 4px 0; font-weight: 600; color: #2563eb;">${ticket.contactPreference}</td>
          </tr>
        </table>
      </div>

      <div style="margin-bottom: 24px;">
        <h4 style="margin: 0 0 12px 0; color: #0f172a; font-size: 14px;">Direct Quick Actions:</h4>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${
            whatsappUrl
              ? `<a href="${whatsappUrl}" target="_blank" style="display: inline-block; background-color: #25d366; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; margin-right: 8px; margin-bottom: 8px;">
                  💬 Open in WhatsApp
                </a>`
              : ""
          }
          ${
            ticket.contactPhone
              ? `<a href="tel:${ticket.contactPhone}" style="display: inline-block; background-color: #0284c7; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; margin-right: 8px; margin-bottom: 8px;">
                  📞 Call Customer
                </a>`
              : ""
          }
          ${
            adminDashboardUrl
              ? `<a href="${adminDashboardUrl}" target="_blank" style="display: inline-block; background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; margin-bottom: 8px;">
                  🖥️ Manage in Admin Portal
                </a>`
              : ""
          }
        </div>
      </div>

      <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; font-size: 11px; color: #94a3b8; text-align: center;">
        This is an automated support notification sent to all Sauda Book administrators.
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: PASSWORD_RESET_FROM_EMAIL || GMAIL_SMTP_EMAIL,
      to: recipients.join(", "),
      subject: `[Support Ticket #${ticket.ticketNo}] ${ticket.priority === "URGENT" ? "🚨 URGENT: " : ""}${ticket.subject}`,
      html,
    });
    return { sent: true, reason: null };
  } catch (error) {
    logger.error("Admin support ticket alert email send failed", {
      feature: "support-ticket",
      ticketId: ticket.id,
      ticketNo: ticket.ticketNo,
      error,
    });
    return { sent: false, reason: "smtp-send-failed" };
  }
}

async function sendSupportTicketStatusUpdateToUser({
  ticket,
  user,
  updatedByAdminName,
}) {
  const transporter = getTransporter();
  if (!transporter || !user?.email) {
    return { sent: false, reason: "smtp-or-recipient-missing" };
  }

  const isResolved = ticket.status === "RESOLVED";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <h2 style="margin: 0 0 12px 0; color: #0f172a; font-size: 20px;">
        Update on your Support Ticket #${ticket.ticketNo}
      </h2>
      <p style="margin: 0 0 16px 0; color: #475569; font-size: 14px;">
        Hi ${escapeHtml(user.name || "there")}, your support request has been updated to <strong>${ticket.status}</strong>.
      </p>

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 14px; margin-bottom: 16px;">
        <p style="margin: 0 0 4px 0; font-size: 12px; color: #64748b; text-transform: uppercase;">Subject</p>
        <p style="margin: 0; font-size: 15px; font-weight: 600; color: #1e293b;">${escapeHtml(ticket.subject)}</p>
      </div>

      ${
        ticket.resolution
          ? `<div style="background-color: #ecfdf5; border-left: 4px solid #10b981; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <h4 style="margin: 0 0 8px 0; color: #065f46; font-size: 14px;">Resolution / Response:</h4>
              <p style="margin: 0; color: #047857; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(ticket.resolution)}</p>
            </div>`
          : ""
      }

      <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-bottom: 20px;">
        If you have any further questions or if your issue is not completely resolved, you can check your ticket status on Sauda Book or reply to this ticket.
      </p>

      <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; font-size: 11px; color: #94a3b8; text-align: center;">
        Sauda Book Support Team
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: PASSWORD_RESET_FROM_EMAIL || GMAIL_SMTP_EMAIL,
      to: user.email,
      subject: `Support Ticket #${ticket.ticketNo} Status: ${ticket.status}`,
      html,
    });
    return { sent: true, reason: null };
  } catch (error) {
    logger.error("User ticket status update email send failed", {
      feature: "support-ticket",
      ticketId: ticket.id,
      ticketNo: ticket.ticketNo,
      error,
    });
    return { sent: false, reason: "smtp-send-failed" };
  }
}

async function sendVerificationEmailOtp(to, otp, name) {
  const cleanTo = String(to || "").trim().toLowerCase();
  if (!cleanTo || !otp) {
    return {
      sent: false,
      reason: !cleanTo ? "missing-recipient" : "missing-otp",
    };
  }

  const cleanName = escapeHtml(name || "Broker / Partner");
  const text = `Hello ${cleanName},

Your one-time verification code for Sauda Book is: ${otp}

This verification code expires in 10 minutes.
Enter this 6-digit code in the Sauda Book verification screen to complete your email verification.

If you did not request this verification code, please ignore this email.
(C) ${new Date().getFullYear()} Sauda Book. All rights reserved.`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; color: #1e293b;">
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="display: inline-block; background-color: #0f766e; color: #ffffff; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; letter-spacing: 0.5px;">
          SAUDA BOOK
        </div>
        <h2 style="margin: 14px 0 6px 0; font-size: 20px; color: #0f172a; font-weight: 800;">
          Verify Your Email Address
        </h2>
        <p style="margin: 0; font-size: 13px; color: #64748b;">
          Hello ${cleanName}, welcome to Sauda Book!
        </p>
      </div>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
        <p style="margin: 0 0 10px 0; font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">
          Your One-Time Verification Code
        </p>
        <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #0f766e; font-family: monospace; padding: 6px 0;">
          ${otp}
        </div>
        <p style="margin: 8px 0 0 0; font-size: 11px; color: #94a3b8;">
          This verification OTP will expire in 10 minutes.
        </p>
      </div>

      <p style="font-size: 12px; color: #64748b; line-height: 1.6; margin-bottom: 16px;">
        Enter this 6-digit code in the Sauda Book verification screen to complete your email verification and unlock uninterrupted access to your textile ledger records and reports.
      </p>

      <div style="border-top: 1px solid #e2e8f0; padding-top: 14px; font-size: 11px; color: #94a3b8; text-align: center;">
        If you did not request this verification code, please ignore this email or contact support.<br>
        &copy; ${new Date().getFullYear()} Sauda Book. All rights reserved.
      </div>
    </div>
  `;

  return await sendUniversalEmail({
    to: cleanTo,
    subject: `${otp} is your Sauda Book Verification Code`,
    html,
    text,
    name: cleanName,
  });
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmailOtp,
  sendSupportTicketAdminAlert,
  sendSupportTicketStatusUpdateToUser,
  EMAIL_TRANSPORT_READY,
  IS_DEVELOPMENT,
};
