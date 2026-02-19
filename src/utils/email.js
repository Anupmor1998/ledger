const { Resend } = require("resend");
const { RESEND_API_KEY, RESEND_FROM_EMAIL } = require("../config/env");

const USING_PLACEHOLDER_KEY = RESEND_API_KEY === "re_xxxxxxxxx";

function createResendClient() {
  if (USING_PLACEHOLDER_KEY) {
    return null;
  }

  return new Resend(RESEND_API_KEY);
}

async function sendPasswordResetEmail(to, token) {
  const resend = createResendClient();
  if (!resend || !to || !token) {
    return false;
  }

  await resend.emails.send({
    from: RESEND_FROM_EMAIL,
    to,
    subject: "Ledger Password Reset",
    html: `<p>Click the link below to reset your password:</p><p><a href="${token}" target="_blank" rel="noopener noreferrer">${token}</a></p><p>This link expires in 15 minutes.</p>`,
  });

  return true;
}

module.exports = {
  sendPasswordResetEmail,
  USING_PLACEHOLDER_KEY,
};
