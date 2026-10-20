const AppError = require("../utils/appError");

/**
 * Calculates current subscription status & entitlement flags for a user object
 */
function getSubscriptionDetails(user) {
  if (!user) {
    return {
      plan: "TRIAL",
      status: "EXPIRED",
      daysRemaining: 0,
      isExpired: true,
      hasFeature: () => false,
    };
  }

  // Admin users have full access to everything
  if (user.role === "ADMIN") {
    return {
      plan: "ADMIN",
      status: "ACTIVE",
      daysRemaining: 9999,
      isExpired: false,
      hasFeature: () => true,
    };
  }

  const isVip =
    user.subscriptionPlan === "COMPLIMENTARY" ||
    (user.subscriptionPlan === "PREMIUM" && user.billingCycle === "LIFETIME") ||
    (user.subscriptionPlan === "PREMIUM" && !user.planExpiresAt);

  if (isVip) {
    return {
      plan: "PREMIUM",
      status: "ACTIVE",
      daysRemaining: 365,
      isExpired: false,
      hasFeature: () => true,
    };
  }

  const now = new Date();
  let daysRemaining = 0;
  let isExpired = false;
  const currentPlan = String(user.subscriptionPlan || "TRIAL").toUpperCase();

  if (currentPlan === "TRIAL") {
    const trialEnd = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
    if (!trialEnd) {
      daysRemaining = 14;
      isExpired = false;
    } else {
      const diff = trialEnd.getTime() - now.getTime();
      daysRemaining = Math.ceil(diff / (1000 * 60 * 60 * 24));
      isExpired = daysRemaining <= 0;
    }
  } else if (user.planExpiresAt) {
    const expiry = new Date(user.planExpiresAt);
    const diff = expiry.getTime() - now.getTime();
    daysRemaining = Math.ceil(diff / (1000 * 60 * 60 * 24));
    isExpired = daysRemaining <= 0;
  } else {
    // Paid plan without explicit expiry date defaults to active
    daysRemaining = 30;
    isExpired = false;
  }

  const hasFeature = (feature) => {
    if (isExpired) return false;

    switch (feature) {
      case "CREATE_RECORDS":
      case "EXCEL_EXPORT":
        return true;
      case "PDF_EXPORT":
        return currentPlan === "TRIAL" || currentPlan === "GROWTH" || currentPlan === "PREMIUM";
      case "ANALYTICS":
      case "MARKET_DIRECTORY":
        return currentPlan === "TRIAL" || currentPlan === "PREMIUM";
      case "AD_FREE":
        return currentPlan === "GROWTH" || currentPlan === "PREMIUM";
      default:
        return true;
    }
  };

  return {
    plan: currentPlan,
    status: isExpired ? "EXPIRED" : user.subscriptionStatus || "ACTIVE",
    daysRemaining: Math.max(0, daysRemaining),
    isExpired,
    hasFeature,
  };
}

/**
 * Middleware: Blocks creating new records (e.g. orders) if trial or subscription is expired.
 */
function requireActiveSubscription(req, res, next) {
  const sub = getSubscriptionDetails(req.user);
  if (sub.isExpired) {
    return next(
      new AppError(
        "Your subscription has expired. Please select or renew your plan to continue creating records.",
        403,
        "SUBSCRIPTION_EXPIRED"
      )
    );
  }
  return next();
}

/**
 * Middleware: Requires a specific feature entitlement (e.g. PDF_EXPORT, ANALYTICS, MARKET_DIRECTORY)
 */
function requireSubscriptionFeature(feature) {
  return (req, res, next) => {
    const sub = getSubscriptionDetails(req.user);

    if (sub.isExpired) {
      return next(
        new AppError(
          "Your subscription has expired. Please upgrade or renew your plan.",
          403,
          "SUBSCRIPTION_EXPIRED"
        )
      );
    }

    if (!sub.hasFeature(feature)) {
      const messages = {
        PDF_EXPORT: "Branded PDF Statement Exports, interactive preview, and WhatsApp sharing are available on the Growth and Premium plans.",
        ANALYTICS: "Visual Analytics Dashboard is an exclusive feature of the Premium plan.",
        MARKET_DIRECTORY: "Market Directory Search is an exclusive feature of the Premium plan.",
      };
      return next(
        new AppError(
          messages[feature] || "This feature is not included in your current subscription plan.",
          403,
          "FEATURE_GATED"
        )
      );
    }

    return next();
  };
}

module.exports = {
  getSubscriptionDetails,
  requireActiveSubscription,
  requireSubscriptionFeature,
};

