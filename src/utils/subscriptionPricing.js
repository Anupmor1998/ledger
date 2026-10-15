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

module.exports = {
  PLAN_PRICING,
  calculateProrationCredit,
};

