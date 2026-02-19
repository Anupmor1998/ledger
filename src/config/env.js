const PORT = process.env.PORT;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

module.exports = {
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  CORS_ORIGINS,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  FRONTEND_URL,
};
