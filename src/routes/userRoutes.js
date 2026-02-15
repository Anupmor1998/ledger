const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { listUsers } = require("../controllers/userController");

const router = express.Router();

router.get("/", authMiddleware, listUsers);

module.exports = router;
