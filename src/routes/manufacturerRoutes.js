const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  createManufacturer,
  listManufacturers,
  getManufacturerById,
  updateManufacturer,
  deleteManufacturer,
} = require("../controllers/manufacturerController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", createManufacturer);
router.get("/", listManufacturers);
router.get("/:id", getManufacturerById);
router.put("/:id", updateManufacturer);
router.delete("/:id", deleteManufacturer);

module.exports = router;
