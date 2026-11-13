const crypto = require("crypto");
const prisma = require("../config/prisma");

// Clean uppercase alphanumeric characters excluding easily confusable characters (0, O, 1, I)
const CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Generate a candidate referral code like ANUP789K or SB4W8X
 * @param {string} name
 * @returns {string}
 */
function generateCandidateCode(name = "") {
  const cleanName = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 4);
  const prefix = cleanName.length >= 3 ? cleanName : "SB";

  let randomPart = "";
  const randomBytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) {
    randomPart += CODE_CHARS[randomBytes[i] % CODE_CHARS.length];
  }
  return `${prefix}${randomPart}`;
}

/**
 * Get or atomically generate and save a unique referral code for a user
 * @param {{ id: string, name?: string, referralCode?: string }} user
 * @returns {Promise<string>}
 */
async function getOrGenerateUserReferralCode(user) {
  if (user && user.referralCode) {
    return user.referralCode;
  }

  let code = "";
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 10) {
    attempts++;
    code = generateCandidateCode(user?.name);
    const existing = await prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!existing) {
      isUnique = true;
    }
  }

  if (!isUnique) {
    code = `SB${Date.now().toString(36).toUpperCase().slice(-6)}`;
  }

  if (user && user.id) {
    await prisma.user.update({
      where: { id: user.id },
      data: { referralCode: code },
    });
  }

  return code;
}

module.exports = {
  generateCandidateCode,
  getOrGenerateUserReferralCode,
};
