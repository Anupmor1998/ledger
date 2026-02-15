const express = require("express");
const authRoutes = require("./routes/authRoutes");
const customerRoutes = require("./routes/customerRoutes");
const healthRoutes = require("./routes/healthRoutes");
const manufacturerRoutes = require("./routes/manufacturerRoutes");
const orderRoutes = require("./routes/orderRoutes");
const qualityRoutes = require("./routes/qualityRoutes");
const userRoutes = require("./routes/userRoutes");
const { notFoundHandler, errorHandler } = require("./middlewares/errorHandler");

const app = express();
const apiPrefix = "/api";

app.use(express.json());

app.use(`${apiPrefix}/health`, healthRoutes);
app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}/users`, userRoutes);
app.use(`${apiPrefix}/customers`, customerRoutes);
app.use(`${apiPrefix}/manufacturers`, manufacturerRoutes);
app.use(`${apiPrefix}/qualities`, qualityRoutes);
app.use(`${apiPrefix}/orders`, orderRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
