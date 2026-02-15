const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createOrder,
  listOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
} = require("../controllers/orderController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", createOrder);
router.get("/", listOrders);
router.get("/:id", getOrderById);
router.put("/:id", updateOrder);
router.delete("/:id", deleteOrder);

module.exports = router;
