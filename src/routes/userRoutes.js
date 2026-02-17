const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
} = require("../controllers/userController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listUsers);
router.get("/me/preferences", getMyPreferences);
router.put("/me/preferences", updateMyPreferences);

module.exports = router;
