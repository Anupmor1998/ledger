const admin = require("firebase-admin");
const { getMessaging } = require("firebase-admin/messaging");
const logger = require("./logger");

let isInitialized = false;
let messagingInstance = null;

function getFirebaseAdmin() {
  if (isInitialized && messagingInstance) {
    return { admin, messaging: messagingInstance };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn("Firebase Admin SDK credentials not fully set in .env. Push notifications will be skipped.");
    return null;
  }

  // Robustly sanitize private key from env
  privateKey = String(privateKey).trim();
  if (privateKey.endsWith(",")) {
    privateKey = privateKey.slice(0, -1).trim();
  }
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.trim();
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  try {
    const apps = admin.getApps ? admin.getApps() : (admin.apps || []);
    let app;
    if (!apps.length) {
      app = admin.initializeApp({
        credential: admin.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    } else {
      app = admin.getApp ? admin.getApp() : apps[0];
    }

    messagingInstance = getMessaging(app);
    isInitialized = true;
    logger.info("Firebase Admin SDK initialized successfully for Push Notifications");
    return { admin, messaging: messagingInstance };
  } catch (error) {
    logger.error("Failed to initialize Firebase Admin SDK", { error: error.message });
    return null;
  }
}

/**
 * Send push notification to a specific list of FCM tokens
 * Automatically handles expired/invalid tokens and cleans them from DB
 */
async function sendPushNotificationToTokens(tokens, payload, prisma = null) {
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }

  const fb = getFirebaseAdmin();
  if (!fb || !fb.messaging) {
    return { successCount: 0, failureCount: tokens.length };
  }

  const { title, body, url, icon, badge } = payload;
  const CHUNK_SIZE = 500;
  let totalSuccess = 0;
  let totalFailure = 0;
  const tokensToRemove = [];

  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    const message = {
      notification: {
        title,
        body,
      },
      webpush: {
        fcmOptions: {
          link: url || "/",
        },
        notification: {
          title,
          body,
          icon: icon || "/icon-192.png",
          badge: badge || "/icon-192.png",
          vibrate: [200, 100, 200],
        },
      },
      tokens: chunk,
    };

    try {
      const response = await fb.messaging.sendEachForMulticast(message);
      totalSuccess += response.successCount;
      totalFailure += response.failureCount;

      if (response.failureCount > 0 && prisma) {
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorCode = resp.error?.code;
            if (
              errorCode === "messaging/invalid-registration-token" ||
              errorCode === "messaging/registration-token-not-registered"
            ) {
              tokensToRemove.push(chunk[idx]);
            }
          }
        });
      }
    } catch (chunkError) {
      logger.error("Error sending FCM multicast chunk", { error: chunkError.message });
      totalFailure += chunk.length;
    }
  }

  // Clean up stale or invalid tokens across all chunks
  if (tokensToRemove.length > 0 && prisma) {
    try {
      await prisma.deviceToken.deleteMany({
        where: { token: { in: tokensToRemove } },
      });
      logger.info("Cleaned up invalid FCM device tokens", { count: tokensToRemove.length });
    } catch (cleanupErr) {
      logger.warn("Failed to clean up stale FCM tokens", { error: cleanupErr.message });
    }
  }

  logger.info("FCM push dispatch complete", {
    totalSuccess,
    totalFailure,
    totalTokens: tokens.length,
  });

  return { successCount: totalSuccess, failureCount: totalFailure };
}

/**
 * Send push notification to all registered users (e.g. for a new public coupon)
 */
async function broadcastPushNotification(prisma, payload) {
  try {
    const deviceTokens = await prisma.deviceToken.findMany({
      select: { token: true },
    });

    if (deviceTokens.length === 0) {
      logger.info("No registered device tokens found for push broadcast");
      return;
    }

    const tokens = deviceTokens.map((dt) => dt.token);
    return await sendPushNotificationToTokens(tokens, payload, prisma);
  } catch (error) {
    logger.error("Error broadcasting push notification", { error: error.message });
  }
}

module.exports = {
  getFirebaseAdmin,
  sendPushNotificationToTokens,
  broadcastPushNotification,
};
