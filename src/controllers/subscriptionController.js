const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { getRazorpayInstance, verifyRazorpaySignature, RAZORPAY_KEY_ID } = require("../config/razorpay");
const logger = require("../utils/logger");

const PLAN_PRICING = {
  STARTER: {
    name: "Starter",
    monthly: 99,
    yearly: 990,
  },
  GROWTH: {
    name: "Growth / Budget",
    monthly: 299,
    yearly: 2990,
  },
  PREMIUM: {
    name: "Premium",
    monthly: 399,
    yearly: 3990,
  },
};

/**
 * Calculate prepaid proration credit when upgrading from an active plan
 */
function calculateProrationCredit(user, targetPlan, targetCycle) {
  const currentPlan = user.subscriptionPlan;
  const currentCycle = user.billingCycle || "MONTHLY";
  const now = new Date();

  // If user is on trial, has no plan expiry date, or plan has already expired: 0 credit
  if (!user.planExpiresAt || currentPlan === "TRIAL") {
    return {
      unusedCredit: 0,
      remainingDays: 0,
      isUpgrade: false,
    };
  }

  const expiry = new Date(user.planExpiresAt);
  if (expiry <= now) {
    return {
      unusedCredit: 0,
      remainingDays: 0,
      isUpgrade: false,
    };
  }

  const diffMs = expiry.getTime() - now.getTime();
  const remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

  // If renewing the exact same plan and cycle: standard renewal, no proration
  const isSamePlanAndCycle = currentPlan === targetPlan && currentCycle === targetCycle;
  if (isSamePlanAndCycle) {
    return {
      unusedCredit: 0,
      remainingDays,
      isUpgrade: false,
    };
  }

  // Calculate daily rate of current plan
  const currentTierPricing = PLAN_PRICING[currentPlan];
  if (!currentTierPricing) {
    return {
      unusedCredit: 0,
      remainingDays: 0,
      isUpgrade: false,
    };
  }

  const totalCycleDays = currentCycle === "YEARLY" ? 365 : 30;
  const currentPlanPrice = currentCycle === "YEARLY" ? currentTierPricing.yearly : currentTierPricing.monthly;
  const dailyRate = currentPlanPrice / totalCycleDays;
  const rawCredit = remainingDays * dailyRate;

  // Credit cannot exceed the original price paid for the active plan
  const unusedCredit = Math.min(currentPlanPrice, Math.round(rawCredit));

  return {
    unusedCredit,
    remainingDays,
    isUpgrade: true,
    previousPlan: currentPlan,
    previousCycle: currentCycle,
  };
}

/**
 * GET /api/subscription/status
 * Return current user's plan, remaining days, validity, and Razorpay key ID for checkout
 */
const getSubscriptionStatus = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      firmName: true,
      contactPhone: true,
      subscriptionPlan: true,
      billingCycle: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      planExpiresAt: true,
      createdAt: true,
    },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  // Calculate remaining days
  const now = new Date();
  let daysRemaining = 0;
  let expiresAt = null;

  if (user.subscriptionPlan === "TRIAL") {
    // 14 days from trialEndsAt or createdAt
    const trialEnd = user.trialEndsAt
      ? new Date(user.trialEndsAt)
      : new Date(new Date(user.createdAt).getTime() + 14 * 24 * 60 * 60 * 1000);
    expiresAt = trialEnd;
    const diff = trialEnd.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  } else if (user.planExpiresAt) {
    expiresAt = new Date(user.planExpiresAt);
    const diff = expiresAt.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  return res.json({
    plan: user.subscriptionPlan || "TRIAL",
    billingCycle: user.billingCycle || "MONTHLY",
    status: user.subscriptionStatus || "ACTIVE",
    daysRemaining,
    expiresAt,
    razorpayKeyId: RAZORPAY_KEY_ID || null,
  });
});

/**
 * POST /api/subscription/preview
 * Calculate price, unused credit from current plan, and net payable amount before opening checkout
 */
const previewSubscriptionOrder = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { plan, billingCycle } = req.body;

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
  const finalPrice = Math.max(1, basePrice - unusedCredit);

  return res.json({
    plan: normalizedPlan,
    billingCycle: normalizedCycle,
    basePrice,
    unusedCredit,
    remainingDays,
    isUpgrade,
    previousPlan,
    finalPrice,
  });
});

/**
 * POST /api/subscription/create-order
 * Create a Razorpay order securely based on plan & billing cycle, applying unused credit
 */
const createSubscriptionOrder = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { plan, billingCycle } = req.body;

  const normalizedPlan = String(plan || "").toUpperCase();
  const normalizedCycle = String(billingCycle || "MONTHLY").toUpperCase();

  const tier = PLAN_PRICING[normalizedPlan];
  if (!tier) {
    throw new AppError(`Invalid plan tier: ${plan}`, 400);
  }

  if (!["MONTHLY", "YEARLY"].includes(normalizedCycle)) {
    throw new AppError(`Invalid billing cycle: ${billingCycle}`, 400);
  }

  const rzp = getRazorpayInstance();
  if (!rzp) {
    throw new AppError(
      "Payment gateway is not configured yet. Please configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server environment.",
      503
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      firmName: true,
      contactPhone: true,
      subscriptionPlan: true,
      billingCycle: true,
      planExpiresAt: true,
    },
  });

  const { unusedCredit, remainingDays, isUpgrade, previousPlan } =
    calculateProrationCredit(user, normalizedPlan, normalizedCycle);

  const basePrice = normalizedCycle === "YEARLY" ? tier.yearly : tier.monthly;
  // Apply unused credit discount (Razorpay minimum is ₹1)
  const finalAmountInRupees = Math.max(1, basePrice - unusedCredit);
  const amountInPaise = finalAmountInRupees * 100;

  const receiptId = `sub_${Date.now().toString().slice(-8)}`;

  const order = await rzp.orders.create({
    amount: amountInPaise,
    currency: "INR",
    receipt: receiptId,
    notes: {
      userId,
      plan: normalizedPlan,
      billingCycle: normalizedCycle,
      basePrice,
      unusedCredit,
      remainingDays,
      isUpgrade: isUpgrade ? "true" : "false",
      previousPlan: previousPlan || "",
      firmName: user?.firmName || "",
      email: user?.email || "",
    },
  });

  // Create pending subscription payment record
  await prisma.subscriptionPayment.create({
    data: {
      userId,
      orderId: order.id,
      amount: finalAmountInRupees,
      currency: "INR",
      plan: normalizedPlan,
      billingCycle: normalizedCycle,
      status: "PENDING",
    },
  });

  return res.json({
    orderId: order.id,
    amount: amountInPaise,
    basePrice,
    unusedCredit,
    remainingDays,
    isUpgrade,
    finalAmount: finalAmountInRupees,
    currency: "INR",
    plan: normalizedPlan,
    billingCycle: normalizedCycle,
    razorpayKeyId: RAZORPAY_KEY_ID,
    user: {
      name: user?.name || user?.firmName || "Broker",
      email: user?.email || "",
      contact: user?.contactPhone || "",
    },
  });
});

/**
 * POST /api/subscription/verify-payment
 * Verify Razorpay signature and activate/extend user plan
 */
const verifySubscriptionPayment = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new AppError("Missing Razorpay payment verification parameters", 400);
  }

  // Cryptographic signature check
  const isValid = verifyRazorpaySignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });

  if (!isValid) {
    logger.warn("Razorpay payment signature mismatch", {
      feature: "subscription",
      userId,
      orderId: razorpay_order_id,
    });
    throw new AppError("Payment verification failed: invalid signature", 400);
  }

  // Find payment record
  const paymentRecord = await prisma.subscriptionPayment.findUnique({
    where: { orderId: razorpay_order_id },
  });

  if (!paymentRecord || paymentRecord.userId !== userId) {
    throw new AppError("Subscription order record not found", 404);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      subscriptionPlan: true,
      billingCycle: true,
      planExpiresAt: true,
    },
  });

  // Calculate new validity
  const isYearly = paymentRecord.billingCycle === "YEARLY";
  const daysToAdd = isYearly ? 365 : 30;
  const now = new Date();

  let newExpiresAt;

  // Check if this was a renewal of the same tier and billing cycle
  const isSamePlanRenewal =
    user?.subscriptionPlan === paymentRecord.plan &&
    user?.billingCycle === paymentRecord.billingCycle;

  if (isSamePlanRenewal && user?.planExpiresAt && new Date(user.planExpiresAt) > now) {
    // Standard renewal: extend from existing expiry date
    newExpiresAt = new Date(new Date(user.planExpiresAt).getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  } else {
    // Upgraded with proration discount: fresh 30 or 365 days start from today!
    newExpiresAt = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  }

  const invoiceNumber = `SB-${now.getFullYear()}-${Date.now().toString().slice(-6)}`;

  // Update payment record to SUCCESS
  await prisma.subscriptionPayment.update({
    where: { id: paymentRecord.id },
    data: {
      paymentId: razorpay_payment_id,
      status: "SUCCESS",
      invoiceNumber,
      paidAt: now,
    },
  });

  // Update user active subscription
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionPlan: paymentRecord.plan,
      billingCycle: paymentRecord.billingCycle,
      subscriptionStatus: "ACTIVE",
      planExpiresAt: newExpiresAt,
    },
    select: {
      id: true,
      email: true,
      name: true,
      firmName: true,
      subscriptionPlan: true,
      billingCycle: true,
      subscriptionStatus: true,
      planExpiresAt: true,
    },
  });

  logger.info("Subscription payment verified successfully", {
    feature: "subscription",
    userId,
    plan: paymentRecord.plan,
    expiresAt: newExpiresAt,
  });

  return res.json({
    success: true,
    message: `Plan upgraded to ${paymentRecord.plan} successfully!`,
    plan: updatedUser.subscriptionPlan,
    billingCycle: updatedUser.billingCycle,
    expiresAt: updatedUser.planExpiresAt,
    invoiceNumber,
    user: updatedUser,
  });
});

/**
 * GET /api/subscription/invoices
 * Retrieve user's past subscription invoices
 */
const getSubscriptionInvoices = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  const invoices = await prisma.subscriptionPayment.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderId: true,
      paymentId: true,
      amount: true,
      currency: true,
      plan: true,
      billingCycle: true,
      status: true,
      invoiceNumber: true,
      paidAt: true,
      createdAt: true,
    },
  });

  return res.json({ invoices });
});

module.exports = {
  getSubscriptionStatus,
  previewSubscriptionOrder,
  createSubscriptionOrder,
  verifySubscriptionPayment,
  getSubscriptionInvoices,
};
