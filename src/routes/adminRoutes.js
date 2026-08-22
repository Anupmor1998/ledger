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
} = require("../controllers/adminController");

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("ADMIN"));

router.get("/collections", listCollections);
router.get("/collections/:collection", listCollectionRecords);
router.get("/collections/:collection/:id", getCollectionRecord);
router.post("/collections/:collection", createCollectionRecord);
router.put("/collections/:collection/:id", updateCollectionRecord);
router.delete("/collections/:collection/:id", deleteCollectionRecord);

module.exports = router;
