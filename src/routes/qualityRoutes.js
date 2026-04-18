const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
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

router.post("/", createQuality);
router.get("/", listQualities);
router.get("/:id", getQualityById);
router.put("/:id", updateQuality);
router.post("/:id/archive", archiveQuality);
router.post("/:id/restore", restoreQuality);
router.delete("/:id", deleteQuality);

module.exports = router;
