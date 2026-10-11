const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  getRazorpayInstance,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
  RAZORPAY_KEY_ID,
} = require("../config/razorpay");
const logger = require("../utils/logger");
const { sendSubscriptionInvoicePdf } = require("../utils/invoicePdf");
const { getSubscriptionDetails } = require("../middlewares/subscriptionGatingMiddleware");

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

  // If user has complimentary / VIP access, represent as PREMIUM on YEARLY billing cycle with never-expiring validity
  const isVipNeverExpires =
    user.subscriptionPlan === "COMPLIMENTARY" ||
    (user.subscriptionPlan === "PREMIUM" && user.billingCycle === "LIFETIME") ||
    (user.subscriptionPlan === "PREMIUM" && !user.planExpiresAt);

  if (isVipNeverExpires) {
    const rollingExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    return res.json({
      plan: "PREMIUM",
      isComplimentary: false,
      isVip: true,
      hasFullAccess: true,
      billingCycle: "YEARLY",
      status: "ACTIVE",
      daysRemaining: 365,
      expiresAt: rollingExpiresAt.toISOString(),
      razorpayKeyId: RAZORPAY_KEY_ID || null,
    });
  }

  // Calculate remaining days
  const now = new Date();
  let daysRemaining = 0;
  let expiresAt = null;

  if (user.subscriptionPlan === "TRIAL") {
    let trialEnd = user.trialEndsAt ? new Date(user.trialEndsAt) : null;

    // For pre-existing accounts accessing with an active session without re-logging in:
    // Initialize a fresh 14 days and persist to database
    if (!trialEnd && !user.planExpiresAt) {
      trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      prisma.user.update({
        where: { id: userId },
        data: { trialEndsAt: trialEnd },
      }).catch(() => {});
    }

    expiresAt = trialEnd;
    const diff = trialEnd ? trialEnd.getTime() - now.getTime() : 0;
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  } else if (user.planExpiresAt) {
    expiresAt = new Date(user.planExpiresAt);
    const diff = expiresAt.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  return res.json({
    plan: user.subscriptionPlan || "TRIAL",
    isComplimentary: false,
    hasFullAccess: ["GROWTH", "PREMIUM", "COMPLIMENTARY"].includes(user.subscriptionPlan),
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

  let order;
  try {
    order = await rzp.orders.create({
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
  } catch (gatewayErr) {
    logger.error("Razorpay order creation failed", {
      feature: "subscription",
      userId,
      plan: normalizedPlan,
      error: gatewayErr,
    });

    const isAuthFailure =
      gatewayErr?.statusCode === 401 ||
      gatewayErr?.error?.code === "BAD_REQUEST_ERROR" ||
      String(gatewayErr?.error?.description || "").toLowerCase().includes("authentication failed");

    if (isAuthFailure) {
      throw new AppError(
        "Payment gateway authentication failed: The RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET configured on the server is invalid or belongs to a different Razorpay merchant account.",
        400
      );
    }

    throw new AppError(
      gatewayErr?.error?.description || gatewayErr?.message || "Failed to initiate payment gateway order",
      400
    );
  }

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
 * Common idempotent function to activate or renew subscription upon verified payment
 */
async function processSuccessfulSubscriptionPayment({ paymentRecord, razorpayPaymentId }) {
  if (paymentRecord.status === "SUCCESS") {
    const existingUser = await prisma.user.findUnique({
      where: { id: paymentRecord.userId },
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

    return {
      updatedPayment: paymentRecord,
      updatedUser: existingUser,
      alreadyActive: true,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: paymentRecord.userId },
    select: {
      id: true,
      subscriptionPlan: true,
      billingCycle: true,
      planExpiresAt: true,
    },
  });

  const isYearly = paymentRecord.billingCycle === "YEARLY";
  const daysToAdd = isYearly ? 365 : 30;
  const now = new Date();

  let newExpiresAt;
  const isSamePlanRenewal =
    user?.subscriptionPlan === paymentRecord.plan &&
    user?.billingCycle === paymentRecord.billingCycle;

  if (isSamePlanRenewal && user?.planExpiresAt && new Date(user.planExpiresAt) > now) {
    // Standard renewal: extend from existing expiry date
    newExpiresAt = new Date(new Date(user.planExpiresAt).getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  } else {
    // Upgraded or expired: fresh 30 or 365 days start from today
    newExpiresAt = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  }

  const invoiceNumber = `SB-${now.getFullYear()}-${Date.now().toString().slice(-6)}`;

  const [updatedPayment, updatedUser] = await prisma.$transaction([
    prisma.subscriptionPayment.update({
      where: { id: paymentRecord.id },
      data: {
        paymentId: razorpayPaymentId,
        status: "SUCCESS",
        invoiceNumber,
        paidAt: now,
      },
    }),
    prisma.user.update({
      where: { id: paymentRecord.userId },
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
    }),
  ]);

  logger.info("Subscription payment activated successfully", {
    feature: "subscription",
    userId: paymentRecord.userId,
    orderId: paymentRecord.orderId,
    paymentId: razorpayPaymentId,
    plan: paymentRecord.plan,
    expiresAt: newExpiresAt,
  });

  return {
    updatedPayment,
    updatedUser,
    alreadyActive: false,
  };
}

/**
 * POST /api/subscription/verify-payment
 * Verify Razorpay signature from frontend checkout callback and activate/extend user plan
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

  const { updatedPayment, updatedUser, alreadyActive } =
    await processSuccessfulSubscriptionPayment({
      paymentRecord,
      razorpayPaymentId: razorpay_payment_id,
    });

  return res.json({
    success: true,
    message: alreadyActive
      ? `Plan ${updatedPayment.plan} is already active.`
      : `Plan upgraded to ${updatedPayment.plan} successfully!`,
    plan: updatedUser.subscriptionPlan,
    billingCycle: updatedUser.billingCycle,
    expiresAt: updatedUser.planExpiresAt,
    invoiceNumber: updatedPayment.invoiceNumber,
    user: updatedUser,
  });
});

/**
 * POST /api/subscription/webhook
 * Asynchronous background webhook called by Razorpay servers upon payment events
 */
const handleRazorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];

  if (!signature) {
    logger.warn("Razorpay webhook received without signature", {
      feature: "subscription",
    });
    return res.status(400).json({ error: "Missing x-razorpay-signature header" });
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);

  let isValid = false;
  try {
    isValid = verifyRazorpayWebhookSignature({ rawBody, signature });
  } catch (err) {
    logger.error("Error validating Razorpay webhook signature", {
      feature: "subscription",
      error: err.message,
    });
    return res.status(500).json({ error: "Webhook validation error" });
  }

  if (!isValid) {
    logger.warn("Razorpay webhook signature validation failed", {
      feature: "subscription",
    });
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const event = req.body?.event;
  const payload = req.body?.payload;

  logger.info(`Razorpay webhook event received: ${event}`, {
    feature: "subscription",
    event,
  });

  if (event === "order.paid" || event === "payment.captured") {
    const orderId =
      payload?.payment?.entity?.order_id || payload?.order?.entity?.id;
    const paymentId = payload?.payment?.entity?.id;

    if (orderId) {
      const paymentRecord = await prisma.subscriptionPayment.findUnique({
        where: { orderId },
      });

      if (paymentRecord) {
        await processSuccessfulSubscriptionPayment({
          paymentRecord,
          razorpayPaymentId: paymentId || paymentRecord.paymentId || "webhook_captured",
        });

        logger.info("Subscription activated via Razorpay webhook", {
          feature: "subscription",
          orderId,
          paymentId,
          userId: paymentRecord.userId,
        });
      }
    }
  } else if (event === "payment.failed") {
    const orderId = payload?.payment?.entity?.order_id;
    const paymentId = payload?.payment?.entity?.id;
    const reason =
      payload?.payment?.entity?.error_description || "Payment failed via webhook";

    if (orderId) {
      const paymentRecord = await prisma.subscriptionPayment.findUnique({
        where: { orderId },
      });

      if (paymentRecord && paymentRecord.status === "PENDING") {
        await prisma.subscriptionPayment.update({
          where: { id: paymentRecord.id },
          data: {
            status: "FAILED",
            paymentId: paymentId || null,
          },
        });

        logger.info("Subscription payment marked FAILED via Razorpay webhook", {
          feature: "subscription",
          orderId,
          reason,
        });
      }
    }
  }

  return res.status(200).json({ status: "ok" });
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

/**
 * POST /api/subscription/fail-order
 * Mark a pending subscription order as FAILED when Razorpay checkout reports failure
 */
const failSubscriptionOrder = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { orderId, paymentId, reason } = req.body;

  if (!orderId) {
    throw new AppError("Order ID is required", 400);
  }

  const paymentRecord = await prisma.subscriptionPayment.findUnique({
    where: { orderId },
  });

  if (!paymentRecord || paymentRecord.userId !== userId) {
    throw new AppError("Subscription order record not found", 404);
  }

  // Only transition if not already successful
  if (paymentRecord.status !== "SUCCESS") {
    await prisma.subscriptionPayment.update({
      where: { id: paymentRecord.id },
      data: {
        status: "FAILED",
        paymentId: paymentId || paymentRecord.paymentId,
      },
    });

    logger.info("Subscription payment marked as failed", {
      feature: "subscription",
      userId,
      orderId,
      reason,
    });
  }

  return res.json({ success: true, status: "FAILED" });
});

/**
 * GET /api/subscription/invoices/:id/download
 * Download a branded Tax Invoice PDF for a successful subscription payment
 */
const downloadSubscriptionInvoice = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const payment = await prisma.subscriptionPayment.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          firmName: true,
          email: true,
          contactPhone: true,
        },
      },
    },
  });

  if (!payment || payment.userId !== userId) {
    throw new AppError("Invoice not found", 404);
  }

  if (payment.status !== "SUCCESS") {
    throw new AppError("Invoices are only generated for successful payments", 400);
  }

  await sendSubscriptionInvoicePdf(res, payment);
});

/**
 * GET /api/subscription/reminders
 * Fetch active in-app reminders and notifications for the user
 */
const getInAppReminders = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = req.user;

  const sub = getSubscriptionDetails(user);
  const reminders = [];

  // 1. Subscription status reminder
  if (sub.isExpired) {
    reminders.push({
      id: "sub-expired",
      type: "URGENT",
      category: "SUBSCRIPTION",
      title: "Subscription Expired",
      message: "Your subscription has expired. Please choose a plan to continue creating orders and reports.",
      actionLabel: "Renew / Upgrade",
      actionUrl: "/subscription",
      createdAt: new Date().toISOString(),
    });
  } else if (sub.daysRemaining <= 5) {
    reminders.push({
      id: "sub-expiring-soon",
      type: "WARNING",
      category: "SUBSCRIPTION",
      title: `${sub.plan === "TRIAL" ? "Free Trial" : "Plan"} Expiring Soon`,
      message: `Your ${sub.plan === "TRIAL" ? "14-day trial" : "subscription"} expires in ${sub.daysRemaining} day${sub.daysRemaining === 1 ? "" : "s"}. Renew today to ensure uninterrupted access.`,
      actionLabel: "Renew / Upgrade",
      actionUrl: "/subscription",
      createdAt: new Date().toISOString(),
    });
  } else {
    reminders.push({
      id: "sub-active",
      type: "SUCCESS",
      category: "SUBSCRIPTION",
      title: `${sub.plan} Plan Active`,
      message: `Your account has full access with ${sub.daysRemaining} days of validity remaining.`,
      actionLabel: "Manage Plan",
      actionUrl: "/subscription",
      createdAt: new Date().toISOString(),
    });
  }

  // 2. Pending customer brokerage balance reminder
  const pendingCount = await prisma.pendingPayment.count({
    where: {
      userId,
      status: { not: "PAID" },
      balanceAmount: { gt: 0 },
    },
  });

  if (pendingCount > 0) {
    const pendingAgg = await prisma.pendingPayment.aggregate({
      where: {
        userId,
        status: { not: "PAID" },
        balanceAmount: { gt: 0 },
      },
      _sum: { balanceAmount: true },
    });
    const totalPending = Math.round(Number(pendingAgg._sum.balanceAmount || 0));
    reminders.push({
      id: "pending-payments",
      type: "INFO",
      category: "PAYMENTS",
      title: "Outstanding Brokerage Due",
      message: `₹${totalPending.toLocaleString("en-IN")} pending payment across ${pendingCount} order${pendingCount === 1 ? "" : "s"}.`,
      actionLabel: "View Payments",
      actionUrl: "/payments",
      createdAt: new Date().toISOString(),
    });
  }

  // 3. Orders in progress reminder
  const pendingOrdersCount = await prisma.order.count({
    where: {
      userId,
      status: "PENDING",
    },
  });

  if (pendingOrdersCount > 0) {
    reminders.push({
      id: "pending-orders",
      type: "INFO",
      category: "ORDERS",
      title: "Orders Pending Completion",
      message: `${pendingOrdersCount} trade order${pendingOrdersCount === 1 ? "" : "s"} currently in progress awaiting dispatch.`,
      actionLabel: "Track Orders",
      actionUrl: "/order-progress",
      createdAt: new Date().toISOString(),
    });
  }

  return res.json({
    reminders,
    unreadCount: reminders.filter((r) => r.type === "URGENT" || r.type === "WARNING").length,
    subscriptionState: {
      plan: sub.plan,
      daysRemaining: sub.daysRemaining,
      isExpired: sub.isExpired,
    },
  });
});

/**
 * POST /api/subscription/test-switch-plan
 * Testing utility: switch subscription plan & validity to test all tiers
 */
const testSwitchPlan = asyncHandler(async (req, res) => {
  // Allow test switching only when explicitly enabled via env (e.g. in staging/dev)
  const isSimulatorEnabled =
    process.env.ENABLE_SUBSCRIPTION_SIMULATOR === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "staging";

  if (!isSimulatorEnabled) {
    throw new AppError("Subscription plan simulator is disabled in this environment", 403);
  }

  const userId = req.user.userId;
  const { mode } = req.body;
  const now = new Date();
  let updateData = {};

  switch (mode) {
    case "TRIAL_ACTIVE":
      updateData = {
        subscriptionPlan: "TRIAL",
        billingCycle: "MONTHLY",
        subscriptionStatus: "ACTIVE",
        trialEndsAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        planExpiresAt: null,
      };
      break;
    case "TRIAL_EXPIRING":
      updateData = {
        subscriptionPlan: "TRIAL",
        billingCycle: "MONTHLY",
        subscriptionStatus: "ACTIVE",
        trialEndsAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
        planExpiresAt: null,
      };
      break;
    case "TRIAL_EXPIRED":
      updateData = {
        subscriptionPlan: "TRIAL",
        billingCycle: "MONTHLY",
        subscriptionStatus: "EXPIRED",
        trialEndsAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
        planExpiresAt: null,
      };
      break;
    case "STARTER":
      updateData = {
        subscriptionPlan: "STARTER",
        billingCycle: "MONTHLY",
        subscriptionStatus: "ACTIVE",
        trialEndsAt: null,
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      };
      break;
    case "GROWTH":
      updateData = {
        subscriptionPlan: "GROWTH",
        billingCycle: "MONTHLY",
        subscriptionStatus: "ACTIVE",
        trialEndsAt: null,
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      };
      break;
    case "PREMIUM":
      updateData = {
        subscriptionPlan: "PREMIUM",
        billingCycle: "YEARLY",
        subscriptionStatus: "ACTIVE",
        trialEndsAt: null,
        planExpiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      };
      break;
    case "PLAN_EXPIRED":
      updateData = {
        subscriptionPlan: "STARTER",
        billingCycle: "MONTHLY",
        subscriptionStatus: "EXPIRED",
        trialEndsAt: null,
        planExpiresAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      };
      break;
    default:
      throw new AppError("Invalid test plan mode", 400);
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      firmName: true,
      role: true,
      subscriptionPlan: true,
      billingCycle: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      planExpiresAt: true,
    },
  });

  return res.json({
    message: `Switched test plan to ${mode}`,
    user: updatedUser,
  });
});

module.exports = {
  getSubscriptionStatus,
  previewSubscriptionOrder,
  createSubscriptionOrder,
  verifySubscriptionPayment,
  handleRazorpayWebhook,
  failSubscriptionOrder,
  getSubscriptionInvoices,
  downloadSubscriptionInvoice,
  getInAppReminders,
  testSwitchPlan,
};
