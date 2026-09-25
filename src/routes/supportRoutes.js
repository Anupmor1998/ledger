const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createTicket,
  getMyTickets,
  getTicketById,
} = require("../controllers/supportTicketController");

const router = express.Router();

router.use(authMiddleware);

router.post("/tickets", createTicket);
router.get("/tickets", getMyTickets);
router.get("/tickets/:id", getTicketById);

module.exports = router;
