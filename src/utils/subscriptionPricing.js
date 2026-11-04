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

const PLAN_TIERS_RANK = {
  TRIAL: 0,
  STARTER: 1,
  GROWTH: 2,
  PREMIUM: 3,
};

/**
 * Validate subscription compatibility for vouchers and orders:
 * 1. Blocks downgrading an active higher-tier plan (e.g. Premium -> Growth/Starter)
 * 2. Checks coupon targetAudience eligibility ("NEW_OR_EXPIRED_ONLY")
 * 3. Identifies and calculates seamless extension for same-tier plans
 */
function checkSubscriptionCompatibility(user, targetPlan, targetCycle, coupon = null) {
  const currentPlan = String(user?.subscriptionPlan || "TRIAL").toUpperCase();
  const currentRank = PLAN_TIERS_RANK[currentPlan] ?? 0;
  const normalizedTargetPlan = String(targetPlan || "").toUpperCase();
  const targetRank = PLAN_TIERS_RANK[normalizedTargetPlan] ?? 1;
  const now = new Date();

  const isCurrentlyActivePaid =
    Boolean(user?.planExpiresAt) &&
    new Date(user.planExpiresAt) > now &&
    currentPlan !== "TRIAL";

  // 1. Check coupon targetAudience eligibility ("NEW_OR_EXPIRED_ONLY")
  if (coupon && coupon.targetAudience === "NEW_OR_EXPIRED_ONLY" && isCurrentlyActivePaid) {
    const diffMs = new Date(user.planExpiresAt).getTime() - now.getTime();
    const remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    return {
      allowed: false,
      reason: "TARGET_AUDIENCE_RESTRICTION",
      message: `This voucher is exclusively for new or expired subscribers. Your account currently has an active ${currentPlan} plan with ${remainingDays} days remaining.`,
    };
  }

  // 2. Prevent accidental downgrades on active paid accounts
  if (isCurrentlyActivePaid && targetRank < currentRank) {
    const diffMs = new Date(user.planExpiresAt).getTime() - now.getTime();
    const remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    return {
      allowed: false,
      reason: "DOWNGRADE_PREVENTION",
      message: `You currently have an active ${currentPlan} plan with ${remainingDays} days remaining. This voucher is valid for the ${normalizedTargetPlan} plan and cannot be used to downgrade an active subscription.`,
    };
  }

  // 3. Extension vs Upgrade vs New
  const isExtension = isCurrentlyActivePaid && currentPlan === normalizedTargetPlan;
  let extendedExpiry = null;
  let extensionDays = 0;
  if (isExtension) {
    extensionDays = String(targetCycle || "MONTHLY").toUpperCase() === "YEARLY" ? 365 : 30;
    extendedExpiry = new Date(new Date(user.planExpiresAt).getTime() + extensionDays * 24 * 60 * 60 * 1000);
  }

  return {
    allowed: true,
    isCurrentlyActivePaid,
    isExtension,
    extensionDays,
    currentExpiry: user?.planExpiresAt || null,
    extendedExpiry: extendedExpiry ? extendedExpiry.toISOString() : null,
    currentPlan,
    targetPlan: normalizedTargetPlan,
  };
}

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

module.exports = {
  PLAN_PRICING,
  PLAN_TIERS_RANK,
  checkSubscriptionCompatibility,
  calculateProrationCredit,
};
