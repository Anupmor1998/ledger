const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
  updateMyProfile,
  listMyRemarkTemplates,
  createMyRemarkTemplate,
  deleteMyRemarkTemplate,
  listMyWhatsAppGroups,
  createMyWhatsAppGroup,
  updateMyWhatsAppGroup,
  deleteMyWhatsAppGroup,
  previewYearTransfer,
  executeYearTransfer,
  listYearTransferBatches,
  getYearTransferBatchDetails,
  undoYearTransferBatch,
} = require("../controllers/userController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", listUsers);
router.put("/me", updateMyProfile);
router.get("/me/preferences", getMyPreferences);
router.put("/me/preferences", updateMyPreferences);
router.get("/me/year-transfer/preview", previewYearTransfer);
router.get("/me/year-transfer/batches", listYearTransferBatches);
router.get("/me/year-transfer/batches/:id", getYearTransferBatchDetails);
router.post("/me/year-transfer/batches/:id/undo", undoYearTransferBatch);
router.post("/me/year-transfer", executeYearTransfer);
router.get("/me/remark-templates", listMyRemarkTemplates);
router.post("/me/remark-templates", createMyRemarkTemplate);
router.delete("/me/remark-templates/:id", deleteMyRemarkTemplate);
router.get("/me/whatsapp-groups", listMyWhatsAppGroups);
router.post("/me/whatsapp-groups", createMyWhatsAppGroup);
router.put("/me/whatsapp-groups/:id", updateMyWhatsAppGroup);
router.delete("/me/whatsapp-groups/:id", deleteMyWhatsAppGroup);

module.exports = router;
