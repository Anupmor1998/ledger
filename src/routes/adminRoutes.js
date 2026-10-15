const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const requireRole = require("../middlewares/requireRole");
const {
  listCollections,
  listCollectionRecords,
  getCollectionRecord,
  createCollectionRecord,
  updateCollectionRecord,
  deleteCollectionRecord,
  adminUpdateUserSubscription,
  toggleUserFreeAccess,
} = require("../controllers/adminController");
const {
  listAllTickets,
  getSupportStats,
  updateTicketStatus,
  deleteTicket,
  streamAdminSupportLive,
} = require("../controllers/supportTicketController");
const {
  listCoupons,
  createCoupon,
  generateCouponBatch,
  updateCoupon,
  deleteCoupon,
} = require("../controllers/couponController");

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("ADMIN"));

router.get("/support/live", streamAdminSupportLive);
router.get("/support/stats", getSupportStats);
router.get("/support/tickets", listAllTickets);
router.patch("/support/tickets/:id", updateTicketStatus);
router.delete("/support/tickets/:id", deleteTicket);

// Coupon management routes
router.get("/coupons", listCoupons);
router.post("/coupons", createCoupon);
router.post("/coupons/generate-batch", generateCouponBatch);
router.patch("/coupons/:id", updateCoupon);
router.delete("/coupons/:id", deleteCoupon);

router.patch("/users/:id/subscription", adminUpdateUserSubscription);
router.patch("/users/:id/free-access", toggleUserFreeAccess);
router.get("/collections", listCollections);
router.get("/collections/:collection", listCollectionRecords);
router.get("/collections/:collection/:id", getCollectionRecord);
router.post("/collections/:collection", createCollectionRecord);
router.put("/collections/:collection/:id", updateCollectionRecord);
router.delete("/collections/:collection/:id", deleteCollectionRecord);

module.exports = router;
