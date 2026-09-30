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
      subject: "Sauda Book Password Reset",
      html: `
        <p>You requested a password reset for your Sauda Book account.</p>
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
  sendSupportTicketAdminAlert,
  sendSupportTicketStatusUpdateToUser,
  EMAIL_TRANSPORT_READY,
  IS_DEVELOPMENT,
};
