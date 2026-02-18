const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const customerRoutes = require("./routes/customerRoutes");
const healthRoutes = require("./routes/healthRoutes");
const manufacturerRoutes = require("./routes/manufacturerRoutes");
const orderRoutes = require("./routes/orderRoutes");
const qualityRoutes = require("./routes/qualityRoutes");
const reportRoutes = require("./routes/reportRoutes");
const userRoutes = require("./routes/userRoutes");
const { CORS_ORIGINS } = require("./config/env");
const { notFoundHandler, errorHandler } = require("./middlewares/errorHandler");

const app = express();
const apiPrefix = "/api";

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json());

app.use(`${apiPrefix}/health`, healthRoutes);
app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}/users`, userRoutes);
app.use(`${apiPrefix}/customers`, customerRoutes);
app.use(`${apiPrefix}/manufacturers`, manufacturerRoutes);
app.use(`${apiPrefix}/qualities`, qualityRoutes);
app.use(`${apiPrefix}/orders`, orderRoutes);
app.use(`${apiPrefix}/reports`, reportRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
