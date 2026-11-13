const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../config/env");

function getSecretKey() {
  return JWT_SECRET || process.env.JWT_SECRET || "ledger-voucher-secret-fallback";
}

function packUuid(uuid) {
  if (!uuid) return "";
  const clean = String(uuid).replace(/-/g, "");
  if (clean.length !== 32) return uuid;
  return Buffer.from(clean, "hex").toString("base64url");
}

function unpackUuid(b64) {
  if (!b64 || b64 === "_") return null;
  try {
    const buf = Buffer.from(b64, "base64url");
    if (buf.length === 16) {
      const hex = buf.toString("hex");
      return (
        hex.slice(0, 8) + "-" +
        hex.slice(8, 12) + "-" +
        hex.slice(12, 16) + "-" +
        hex.slice(16, 20) + "-" +
        hex.slice(20)
      );
    }
  } catch {}
  return b64;
}

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

/**
 * Compact cryptographic voucher lock token
 * Produces ~55-60 char clean single-line token instead of 280+ char verbose JWT
 */
function createVoucherLockToken(payload, expiresIn = "60d") {
  const { code, targetUserId, targetPhone } = payload || {};
  const normalizedCode = String(code || "").trim().toUpperCase();

  // If not locked to any user or phone, the token is simply the code itself
  if (!targetUserId && !targetPhone) {
    return normalizedCode;
  }

  const packedUser = packUuid(targetUserId);
  const rawPhone = targetPhone ? String(targetPhone).replace(/\D/g, "").slice(-10) : "";

  let durationSec = 60 * 86400;
  if (typeof expiresIn === "number") {
    durationSec = expiresIn;
  } else if (typeof expiresIn === "string" && expiresIn.endsWith("d")) {
    const days = parseInt(expiresIn, 10);
    if (!isNaN(days)) durationSec = days * 86400;
  }
  const expSec = Math.floor(Date.now() / 1000) + durationSec;
  const expStr = expSec.toString(36);

  const dataToSign = `V1:${normalizedCode}:${packedUser}:${rawPhone}:${expStr}`;
  const hmac = crypto.createHmac("sha256", getSecretKey());
  hmac.update(dataToSign);
  const sig = hmac.digest().subarray(0, 8).toString("base64url");

  return `${normalizedCode}.${packedUser || "_"}.${rawPhone || "_"}.${expStr}.${sig}`;
}

function verifyVoucherLockToken(token) {
  if (!token) throw new Error("Voucher token is required");
  const trimmed = String(token).trim();

  // Backwards compatibility with standard 3-part JWT
  if (trimmed.startsWith("eyJ")) {
    const payload = jwt.verify(trimmed, getSecretKey());
    if (payload.tokenType !== "VOUCHER_LOCK") {
      throw new Error("Invalid token type for voucher lock");
    }
    return payload;
  }

  const parts = trimmed.split(".");
  // Case: Single word/code (unlocked general link)
  if (parts.length === 1) {
    return {
      code: parts[0].toUpperCase(),
      targetUserId: null,
      targetPhone: null,
      isLocked: false,
    };
  }

  // Case: Compact 5-part token: code.packedUser.phone.exp.sig
  if (parts.length === 5) {
    const [code, packedUser, rawPhone, expStr, sig] = parts;
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = parseInt(expStr, 36);
    if (isNaN(expSec) || nowSec > expSec) {
      throw new Error("This voucher link has expired");
    }

    const cleanUser = packedUser === "_" ? "" : packedUser;
    const cleanPhone = rawPhone === "_" ? "" : rawPhone;
    const dataToSign = `V1:${code.toUpperCase()}:${cleanUser}:${cleanPhone}:${expStr}`;
    const hmac = crypto.createHmac("sha256", getSecretKey());
    hmac.update(dataToSign);
    const expectedSig = hmac.digest().subarray(0, 8).toString("base64url");

    if (sig !== expectedSig) {
      throw new Error("Invalid voucher lock signature");
    }

    return {
      code: code.toUpperCase(),
      targetUserId: unpackUuid(packedUser),
      targetPhone: cleanPhone || null,
      isLocked: Boolean(cleanUser || cleanPhone),
    };
  }

  throw new Error("Invalid voucher link format");
}

module.exports = {
  createToken,
  verifyToken,
  createReportShareToken,
  verifyReportShareToken,
  createVoucherLockToken,
  verifyVoucherLockToken,
};
