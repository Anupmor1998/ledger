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

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("ADMIN"));

router.get("/support/live", streamAdminSupportLive);
router.get("/support/stats", getSupportStats);
router.get("/support/tickets", listAllTickets);
router.patch("/support/tickets/:id", updateTicketStatus);
router.delete("/support/tickets/:id", deleteTicket);

router.patch("/users/:id/subscription", adminUpdateUserSubscription);
router.patch("/users/:id/free-access", toggleUserFreeAccess);
router.get("/collections", listCollections);
router.get("/collections/:collection", listCollectionRecords);
router.get("/collections/:collection/:id", getCollectionRecord);
router.post("/collections/:collection", createCollectionRecord);
router.put("/collections/:collection/:id", updateCollectionRecord);
router.delete("/collections/:collection/:id", deleteCollectionRecord);

module.exports = router;
