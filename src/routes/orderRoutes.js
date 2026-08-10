const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createOrder,
  listOrders,
  getOrderById,
  getOrderActivity,
  listOrderActivities,
  updateOrder,
  deleteOrder,
} = require("../controllers/orderController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", createOrder);
router.get("/", listOrders);
router.get("/activity-feed", listOrderActivities);
router.get("/:id", getOrderById);
router.get("/:id/activity", getOrderActivity);
router.put("/:id", updateOrder);
router.delete("/:id", deleteOrder);

module.exports = router;
