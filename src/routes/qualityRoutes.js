const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireActiveSubscription } = require("../middlewares/subscriptionGatingMiddleware");
const {
  createQuality,
  listQualities,
  getQualityById,
  updateQuality,
  deleteQuality,
  archiveQuality,
  restoreQuality,
} = require("../controllers/qualityController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", requireActiveSubscription, createQuality);
router.get("/", listQualities);
router.get("/:id", getQualityById);
router.put("/:id", updateQuality);
router.post("/:id/archive", archiveQuality);
router.post("/:id/restore", restoreQuality);
router.delete("/:id", deleteQuality);

module.exports = router;
