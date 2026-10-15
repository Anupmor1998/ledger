const crypto = require("crypto");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { PLAN_PRICING, calculateProrationCredit } = require("../utils/subscriptionPricing");

/**
 * Validate a coupon and calculate discount against a given amount
 */
function calculateCouponDiscount(coupon, amount) {
  if (!coupon) {
    throw new AppError("Coupon not found.", 404);
  }

  if (!coupon.isActive) {
    throw new AppError("This coupon code is currently disabled.", 400);
  }

  if (coupon.expiresAt && new Date() > new Date(coupon.expiresAt)) {
    throw new AppError("This coupon code has expired.", 400);
  }

  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
    throw new AppError("This coupon code has reached its maximum usage limit.", 400);
  }

  const minOrder = Number(coupon.minOrderAmount || 0);
  if (amount < minOrder) {
    throw new AppError(
      `This coupon requires a minimum purchase value of ₹${minOrder.toLocaleString("en-IN")}.`,
      400
    );
  }

  let discount = 0;
  if (coupon.discountType === "PERCENTAGE") {
    discount = Math.round((amount * Number(coupon.discountValue)) / 100);
    if (coupon.maxDiscount && discount > Number(coupon.maxDiscount)) {
      discount = Number(coupon.maxDiscount);
    }
  } else {
    // FLAT
    discount = Math.min(Number(coupon.discountValue), amount);
  }

  const finalPrice = Math.max(0, amount - discount);

  return {
    discount,
    finalPrice,
  };
}

/**
 * Check if the user has reached their maximum allowed uses for a coupon.
 * Only successfully completed payments (status: "SUCCESS") count against the limit.
 */
async function checkCouponPerUserLimit(coupon, userId) {
  if (!coupon || !userId) return;
  const maxPerUser = coupon.maxUsesPerUser || 1;
  const userRedemptions = await prisma.subscriptionPayment.count({
    where: {
      userId,
      couponId: coupon.id,
      status: "SUCCESS",
    },
  });

  if (userRedemptions >= maxPerUser) {
    throw new AppError(
      maxPerUser === 1
        ? "You have already used this coupon code."
        : `You have reached the maximum allowed uses (${maxPerUser}) for this coupon code.`,
      400
    );
  }
}

/**
 * Generate a random alphanumeric string for coupon codes
 */
function generateRandomCode(length = 6) {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude ambiguous 0, O, 1, I
  let result = "";
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Safely parse expiry date, setting to end-of-day (23:59:59.999) if a YYYY-MM-DD date is provided
 */
function parseExpiryDate(expiresAt) {
  if (!expiresAt) return null;
  let str = String(expiresAt).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    str += "T23:59:59.999";
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) {
    throw new AppError("Invalid expiry date format.", 400);
  }
  return d;
}

/**
 * USER: POST /api/subscription/validate-coupon
 * Validate a coupon code and preview discount for checkout
 */
const validateCoupon = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { code, plan, billingCycle } = req.body;

  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) {
    throw new AppError("Please enter a coupon code.", 400);
  }

  const normalizedPlan = String(plan || "").toUpperCase();
  const normalizedCycle = String(billingCycle || "MONTHLY").toUpperCase();

  const tier = PLAN_PRICING[normalizedPlan];
  if (!tier) {
    throw new AppError(`Invalid plan tier: ${plan}`, 400);
  }

  if (!["MONTHLY", "YEARLY"].includes(normalizedCycle)) {
    throw new AppError(`Invalid billing cycle: ${billingCycle}`, 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionPlan: true,
      billingCycle: true,
      planExpiresAt: true,
    },
  });

  const { unusedCredit, remainingDays, isUpgrade, previousPlan } =
    calculateProrationCredit(user, normalizedPlan, normalizedCycle);

  const basePrice = normalizedCycle === "YEARLY" ? tier.yearly : tier.monthly;
  const preDiscountPayable = Math.max(0, basePrice - unusedCredit);

  const coupon = await prisma.coupon.findUnique({
    where: { code: normalizedCode },
  });

  if (!coupon) {
    throw new AppError(`Coupon code "${normalizedCode}" is invalid.`, 400);
  }

  // Check per-user limit based on completed SUCCESS payments
  await checkCouponPerUserLimit(coupon, userId);

  const { discount, finalPrice } = calculateCouponDiscount(coupon, preDiscountPayable);

  return res.json({
    valid: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      maxUsesPerUser: coupon.maxUsesPerUser,
      expiresAt: coupon.expiresAt,
    },
    basePrice,
    unusedCredit,
    remainingDays,
    isUpgrade,
    previousPlan,
    discountAmount: discount,
    finalPrice,
  });
});

/**
 * USER: GET /api/subscription/available-coupons
 * Fetch public coupons visible in the subscription checkout flow, excluding those already exhausted by the user.
 */
const getAvailableCoupons = asyncHandler(async (req, res) => {
  const userId = req.user?.userId;
  const now = new Date();

  // Find all active, public coupons that are either non-expiring or not yet expired
  const coupons = await prisma.coupon.findMany({
    where: {
      isActive: true,
      isPublic: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ discountValue: "desc" }, { createdAt: "desc" }],
  });

  // Filter out any coupon whose total global max uses limit has been reached
  const globallyAvailable = coupons.filter(
    (c) => !c.maxUses || c.usedCount < c.maxUses
  );

  if (!userId || globallyAvailable.length === 0) {
    return res.json({
      coupons: globallyAvailable.map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        minOrderAmount: c.minOrderAmount,
        maxDiscount: c.maxDiscount,
        expiresAt: c.expiresAt,
      })),
    });
  }

  // Count SUCCESS payments made by this user for each available coupon
  const userRedemptions = await prisma.subscriptionPayment.groupBy({
    by: ["couponId"],
    where: {
      userId,
      status: "SUCCESS",
      couponId: { in: globallyAvailable.map((c) => c.id) },
    },
    _count: { id: true },
  });

  const redemptionMap = new Map();
  userRedemptions.forEach((r) => {
    if (r.couponId) redemptionMap.set(r.couponId, r._count.id);
  });

  const eligibleCoupons = globallyAvailable.filter((c) => {
    const userUsed = redemptionMap.get(c.id) || 0;
    const maxPerUser = c.maxUsesPerUser || 1;
    return userUsed < maxPerUser;
  });

  return res.json({
    coupons: eligibleCoupons.map((c) => ({
      id: c.id,
      code: c.code,
      description: c.description,
      discountType: c.discountType,
      discountValue: c.discountValue,
      minOrderAmount: c.minOrderAmount,
      maxDiscount: c.maxDiscount,
      expiresAt: c.expiresAt,
    })),
  });
});

/**
 * ADMIN: GET /api/admin/coupons
 * List all coupons with search, status filters, and pagination
 */
const listCoupons = asyncHandler(async (req, res) => {
  const { search, status, page = 1, limit = 20 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * take;

  const where = {};

  if (search) {
    const query = String(search).trim();
    where.OR = [
      { code: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
    ];
  }

  const now = new Date();
  const normalizedStatus = String(status || "").toLowerCase();
  if (normalizedStatus === "active") {
    where.isActive = true;
    where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
  } else if (normalizedStatus === "expired") {
    where.expiresAt = { lte: now };
  } else if (normalizedStatus === "inactive" || normalizedStatus === "disabled") {
    where.isActive = false;
  }

  const [coupons, filteredTotal, overallTotal, activeCount, expiredCount, totalRedemptions] =
    await Promise.all([
      prisma.coupon.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: { payments: true },
          },
        },
      }),
      prisma.coupon.count({ where }),
      prisma.coupon.count(),
      prisma.coupon.count({
        where: {
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      }),
      prisma.coupon.count({
        where: {
          expiresAt: { lte: now },
        },
      }),
      prisma.coupon.aggregate({
        _sum: { usedCount: true },
      }),
    ]);

  return res.json({
    coupons,
    pagination: {
      total: filteredTotal,
      page: pageNum,
      limit: take,
      totalPages: Math.ceil(filteredTotal / take) || 1,
    },
    stats: {
      total: overallTotal,
      totalCoupons: overallTotal,
      active: activeCount,
      activeCoupons: activeCount,
      expired: expiredCount,
      expiredCoupons: expiredCount,
      totalRedemptions: totalRedemptions._sum.usedCount || 0,
    },
  });
});

/**
 * ADMIN: POST /api/admin/coupons
 * Create a single coupon with custom parameters
 */
const createCoupon = asyncHandler(async (req, res) => {
  const {
    code,
    description,
    discountType = "PERCENTAGE",
    discountValue,
    minOrderAmount = 0,
    maxDiscount,
    maxUses,
    maxUsesPerUser = 1,
    isPublic = false,
    expiresAt,
    isActive = true,
  } = req.body;

  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode || normalizedCode.length < 3) {
    throw new AppError("Coupon code must be at least 3 characters long.", 400);
  }

  if (!/^[A-Z0-9_-]+$/.test(normalizedCode)) {
    throw new AppError(
      "Coupon code can only contain uppercase letters, numbers, hyphens, and underscores.",
      400
    );
  }

  const numDiscount = Number(discountValue);
  if (!Number.isFinite(numDiscount) || numDiscount <= 0) {
    throw new AppError("Discount value must be a positive number.", 400);
  }

  if (discountType === "PERCENTAGE" && numDiscount > 100) {
    throw new AppError("Percentage discount cannot exceed 100%.", 400);
  }

  const existing = await prisma.coupon.findUnique({
    where: { code: normalizedCode },
  });
  if (existing) {
    throw new AppError(`A coupon with code "${normalizedCode}" already exists.`, 409);
  }

  const parsedExpiresAt = parseExpiryDate(expiresAt);
  const parsedMaxUsesPerUser =
    maxUsesPerUser !== undefined && maxUsesPerUser !== null && maxUsesPerUser !== ""
      ? Math.max(1, parseInt(maxUsesPerUser, 10) || 1)
      : 1;

  const coupon = await prisma.coupon.create({
    data: {
      code: normalizedCode,
      description: description ? String(description).trim() : null,
      discountType: discountType === "FLAT" ? "FLAT" : "PERCENTAGE",
      discountValue: numDiscount,
      minOrderAmount: Math.max(0, Number(minOrderAmount) || 0),
      maxDiscount: maxDiscount ? Number(maxDiscount) : null,
      maxUses: maxUses ? parseInt(maxUses, 10) : null,
      maxUsesPerUser: parsedMaxUsesPerUser,
      expiresAt: parsedExpiresAt,
      isActive: Boolean(isActive),
      isPublic: Boolean(isPublic),
      createdById: req.user.userId,
    },
  });

  return res.status(201).json({
    message: "Coupon created successfully.",
    coupon,
  });
});

/**
 * ADMIN: POST /api/admin/coupons/generate-batch
 * Generate any number of coupons at once with a custom prefix and expiry date
 */
const generateCouponBatch = asyncHandler(async (req, res) => {
  const {
    count = 5,
    prefix = "PROMO",
    description,
    discountType = "PERCENTAGE",
    discountValue,
    minOrderAmount = 0,
    maxDiscount,
    maxUses = 1,
    maxUsesPerUser = 1,
    isPublic = false,
    expiresAt,
  } = req.body;

  const totalCount = Math.min(200, Math.max(1, parseInt(count, 10) || 5));
  const normalizedPrefix = String(prefix || "PROMO")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const numDiscount = Number(discountValue);
  if (!Number.isFinite(numDiscount) || numDiscount <= 0) {
    throw new AppError("Discount value must be a positive number.", 400);
  }

  if (discountType === "PERCENTAGE" && numDiscount > 100) {
    throw new AppError("Percentage discount cannot exceed 100%.", 400);
  }

  const parsedExpiresAt = parseExpiryDate(expiresAt);
  const parsedMaxUsesPerUser =
    maxUsesPerUser !== undefined && maxUsesPerUser !== null && maxUsesPerUser !== ""
      ? Math.max(1, parseInt(maxUsesPerUser, 10) || 1)
      : 1;

  // Generate unique codes
  const generatedCodes = new Set();
  const existingCodesRaw = await prisma.coupon.findMany({
    select: { code: true },
  });
  const existingCodesSet = new Set(existingCodesRaw.map((c) => c.code));

  while (generatedCodes.size < totalCount) {
    const randomSuffix = generateRandomCode(6);
    const code = normalizedPrefix ? `${normalizedPrefix}-${randomSuffix}` : randomSuffix;
    if (!existingCodesSet.has(code)) {
      generatedCodes.add(code);
    }
  }

  const couponsData = Array.from(generatedCodes).map((code) => ({
    code,
    description: description ? String(description).trim() : null,
    discountType: discountType === "FLAT" ? "FLAT" : "PERCENTAGE",
    discountValue: numDiscount,
    minOrderAmount: Math.max(0, Number(minOrderAmount) || 0),
    maxDiscount: maxDiscount ? Number(maxDiscount) : null,
    maxUses: maxUses ? parseInt(maxUses, 10) : null,
    maxUsesPerUser: parsedMaxUsesPerUser,
    expiresAt: parsedExpiresAt,
    isActive: true,
    isPublic: Boolean(isPublic),
    createdById: req.user.userId,
  }));

  await prisma.coupon.createMany({
    data: couponsData,
  });

  const createdCoupons = await prisma.coupon.findMany({
    where: {
      code: { in: Array.from(generatedCodes) },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.status(201).json({
    message: `Successfully generated ${createdCoupons.length} coupon codes.`,
    count: createdCoupons.length,
    coupons: createdCoupons,
  });
});

/**
 * ADMIN: PATCH /api/admin/coupons/:id
 * Update coupon properties (active status, expiry date, max uses, description)
 */
const updateCoupon = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    isActive,
    isPublic,
    expiresAt,
    maxUses,
    maxUsesPerUser,
    description,
    maxDiscount,
    minOrderAmount,
  } = req.body;

  const coupon = await prisma.coupon.findUnique({
    where: { id },
  });

  if (!coupon) {
    throw new AppError("Coupon not found.", 404);
  }

  const data = {};

  if (typeof isActive === "boolean") {
    data.isActive = isActive;
  }

  if (typeof isPublic === "boolean") {
    data.isPublic = isPublic;
  }

  if (expiresAt !== undefined) {
    data.expiresAt = parseExpiryDate(expiresAt);
  }

  if (maxUses !== undefined) {
    data.maxUses = maxUses ? parseInt(maxUses, 10) : null;
  }

  if (maxUsesPerUser !== undefined) {
    data.maxUsesPerUser = maxUsesPerUser ? Math.max(1, parseInt(maxUsesPerUser, 10) || 1) : 1;
  }

  if (description !== undefined) {
    data.description = description ? String(description).trim() : null;
  }

  if (maxDiscount !== undefined) {
    data.maxDiscount = maxDiscount ? Number(maxDiscount) : null;
  }

  if (minOrderAmount !== undefined) {
    data.minOrderAmount = Math.max(0, Number(minOrderAmount) || 0);
  }

  const updated = await prisma.coupon.update({
    where: { id },
    data,
  });

  return res.json({
    message: "Coupon updated successfully.",
    coupon: updated,
  });
});

/**
 * ADMIN: DELETE /api/admin/coupons/:id
 * Delete coupon or deactivate if payments are linked
 */
const deleteCoupon = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const coupon = await prisma.coupon.findUnique({
    where: { id },
    include: {
      _count: { select: { payments: true } },
    },
  });

  if (!coupon) {
    throw new AppError("Coupon not found.", 404);
  }

  if (coupon._count.payments > 0) {
    // If payments are linked, soft-deactivate instead to preserve historical billing integrity
    await prisma.coupon.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({
      message:
        "Coupon has linked payment records. It has been deactivated to preserve transaction history.",
      deactivated: true,
    });
  }

  await prisma.coupon.delete({
    where: { id },
  });

  return res.json({
    message: "Coupon deleted successfully.",
  });
});

module.exports = {
  calculateCouponDiscount,
  checkCouponPerUserLimit,
  getAvailableCoupons,
  validateCoupon,
  listCoupons,
  createCoupon,
  generateCouponBatch,
  updateCoupon,
  deleteCoupon,
};
