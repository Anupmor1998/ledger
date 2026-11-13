const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const { getOrGenerateUserReferralCode } = require("../utils/referralCode");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://saudabook.co.in";

/**
 * GET /api/referral/me
 * Returns current user's referral code, share link, live stats, and list of referred friends
 */
const getMyReferralInfo = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      referralCode: true,
      referralDaysEarned: true,
      referralDaysYear: true,
    },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  // Ensure user has a referral code
  const code = await getOrGenerateUserReferralCode(user);

  // Annual cap check: 90 days per calendar year
  const currentYear = new Date().getFullYear();
  let daysEarned = user.referralDaysYear === currentYear ? (user.referralDaysEarned || 0) : 0;
  const maxDaysYear = 90;
  const daysRemaining = Math.max(0, maxDaysYear - daysEarned);

  // Fetch all referrals made by this user
  const referrals = await prisma.referralRecord.findMany({
    where: { referrerId: userId },
    include: {
      referee: {
        select: {
          id: true,
          name: true,
          firmName: true,
          contactPhone: true,
          subscriptionPlan: true,
          subscriptionStatus: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const formattedReferrals = referrals.map((r) => {
    const rawPhone = r.referee?.contactPhone;
    const maskedPhone = rawPhone && rawPhone.length >= 10
      ? `${rawPhone.slice(0, 2)}******${rawPhone.slice(-2)}`
      : null;

    return {
      id: r.id,
      status: r.status, // "REGISTERED" or "CONVERTED"
      rewardDays: r.rewardDays,
      rewardGranted: r.rewardGranted,
      rewardGrantedAt: r.rewardGrantedAt,
      createdAt: r.createdAt,
      refereeName: r.referee?.name || "Friend",
      refereeFirm: r.referee?.firmName || null,
      refereePhoneMasked: maskedPhone,
      refereePlan: r.referee?.subscriptionPlan || "FREE",
      refereeStatus: r.referee?.subscriptionStatus || "ACTIVE",
    };
  });

  const totalInvited = formattedReferrals.length;
  const totalConverted = formattedReferrals.filter((r) => r.status === "CONVERTED").length;

  const baseUrl = FRONTEND_URL.endsWith("/") ? FRONTEND_URL.slice(0, -1) : FRONTEND_URL;
  const referralLink = `${baseUrl}/signup?ref=${code}`;

  return res.json({
    success: true,
    referralCode: code,
    referralLink,
    stats: {
      totalInvited,
      totalConverted,
      daysEarned,
      maxDaysYear,
      daysRemaining,
      rewardDaysPerFriend: 15,
      bonusDaysForFriend: 15,
      totalTrialDaysForFriend: 29,
    },
    referrals: formattedReferrals,
  });
});

/**
 * GET /api/referral/validate/:code
 * Public endpoint to check if a referral code is valid
 */
const validateReferralCode = asyncHandler(async (req, res) => {
  const { code } = req.params;

  if (!code || typeof code !== "string" || !code.trim()) {
    throw new AppError("Referral code is required", 400);
  }

  const cleanCode = code.trim().toUpperCase();

  const referrer = await prisma.user.findUnique({
    where: { referralCode: cleanCode },
    select: {
      id: true,
      name: true,
      firmName: true,
    },
  });

  if (!referrer) {
    return res.status(404).json({
      valid: false,
      message: "Invalid referral code. Please check and try again.",
    });
  }

  const displayName = referrer.name
    ? referrer.name.trim().split(" ")[0]
    : referrer.firmName
    ? referrer.firmName.trim()
    : "A friend";

  return res.json({
    valid: true,
    code: cleanCode,
    referrerName: displayName,
    bonusDays: 15,
    totalTrialDays: 29,
    message: `Valid code from ${displayName}! You will receive a 29-day free trial.`,
  });
});

module.exports = {
  getMyReferralInfo,
  validateReferralCode,
};
