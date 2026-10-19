const jwt = require("jsonwebtoken");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../config/env");

function createToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function createReportShareToken(payload, expiresIn = "30d") {
  return jwt.sign({ ...payload, tokenType: "REPORT_SHARE" }, JWT_SECRET, { expiresIn });
}

function verifyReportShareToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.tokenType !== "REPORT_SHARE") {
    throw new Error("Invalid token type for report share");
  }
  return payload;
}

module.exports = {
  createToken,
  verifyToken,
  createReportShareToken,
  verifyReportShareToken,
};
