const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createCustomer,
  checkCustomerDuplicates,
  listCustomerDuplicateGroups,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  previewMergeCustomer,
  mergeCustomer,
  resolveCustomerDuplicates,
} = require("../controllers/customerController");

const router = express.Router();

router.use(authMiddleware);

router.post("/check-duplicates", checkCustomerDuplicates);
router.post("/resolve-duplicates", resolveCustomerDuplicates);
router.post("/", createCustomer);
router.get("/duplicate-groups", listCustomerDuplicateGroups);
router.get("/", listCustomers);
router.get("/:id", getCustomerById);
router.get("/:id/merge-preview", previewMergeCustomer);
router.post("/:id/merge", mergeCustomer);
router.put("/:id", updateCustomer);
router.delete("/:id", deleteCustomer);

module.exports = router;
