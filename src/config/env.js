const PORT = process.env.PORT;
const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN;
const FRONTEND_URL = process.env.FRONTEND_URL;
const GMAIL_SMTP_EMAIL = process.env.GMAIL_SMTP_EMAIL;
const GMAIL_SMTP_APP_PASSWORD = process.env.GMAIL_SMTP_APP_PASSWORD;
const PASSWORD_RESET_FROM_EMAIL = process.env.PASSWORD_RESET_FROM_EMAIL;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

module.exports = {
  PORT,
  NODE_ENV,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  CORS_ORIGINS,
  FRONTEND_URL,
  GMAIL_SMTP_EMAIL,
  GMAIL_SMTP_APP_PASSWORD,
  PASSWORD_RESET_FROM_EMAIL,
};
