const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getMarketDirectory,
  tagPartyQuality,
  untagPartyQuality,
} = require("../controllers/directoryController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getMarketDirectory);
router.post("/tag-quality", tagPartyQuality);
router.delete("/tag-quality", untagPartyQuality);

module.exports = router;

