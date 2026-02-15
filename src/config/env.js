const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";

module.exports = {
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
};
