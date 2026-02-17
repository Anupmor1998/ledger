const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

module.exports = {
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  CORS_ORIGIN,
};
