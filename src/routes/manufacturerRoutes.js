const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createManufacturer,
  checkManufacturerDuplicates,
  listManufacturerDuplicateGroups,
  listManufacturers,
  getManufacturerById,
  updateManufacturer,
  deleteManufacturer,
  previewMergeManufacturer,
  mergeManufacturer,
  resolveManufacturerDuplicates,
} = require("../controllers/manufacturerController");

const router = express.Router();

router.use(authMiddleware);

router.post("/check-duplicates", checkManufacturerDuplicates);
router.post("/resolve-duplicates", resolveManufacturerDuplicates);
router.post("/", createManufacturer);
router.get("/duplicate-groups", listManufacturerDuplicateGroups);
router.get("/", listManufacturers);
router.get("/:id", getManufacturerById);
router.get("/:id/merge-preview", previewMergeManufacturer);
router.post("/:id/merge", mergeManufacturer);
router.put("/:id", updateManufacturer);
router.delete("/:id", deleteManufacturer);

module.exports = router;
