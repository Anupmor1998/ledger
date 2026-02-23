const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
  updateMyProfile,
  listMyWhatsAppGroups,
  createMyWhatsAppGroup,
  updateMyWhatsAppGroup,
  deleteMyWhatsAppGroup,
} = require("../controllers/userController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listUsers);
router.put("/me", updateMyProfile);
router.get("/me/preferences", getMyPreferences);
router.put("/me/preferences", updateMyPreferences);
router.get("/me/whatsapp-groups", listMyWhatsAppGroups);
router.post("/me/whatsapp-groups", createMyWhatsAppGroup);
router.put("/me/whatsapp-groups/:id", updateMyWhatsAppGroup);
router.delete("/me/whatsapp-groups/:id", deleteMyWhatsAppGroup);

module.exports = router;
