const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { getMarketDirectory } = require("../controllers/directoryController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getMarketDirectory);

module.exports = router;
