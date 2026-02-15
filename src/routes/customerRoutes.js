const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
} = require("../controllers/customerController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", createCustomer);
router.get("/", listCustomers);
router.get("/:id", getCustomerById);
router.put("/:id", updateCustomer);
router.delete("/:id", deleteCustomer);

module.exports = router;
