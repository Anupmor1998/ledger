const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
  updateMyProfile,
} = require("../controllers/userController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listUsers);
router.put("/me", updateMyProfile);
router.get("/me/preferences", getMyPreferences);
router.put("/me/preferences", updateMyPreferences);

module.exports = router;
