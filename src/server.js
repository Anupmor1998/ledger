require("dotenv").config();

const app = require("./app");
const { PORT, NODE_ENV } = require("./config/env");
const logger = require("./utils/logger");

const server = app.listen(PORT, () => {
  logger.info("Server started", {
    feature: "server",
    port: PORT,
    environment: NODE_ENV,
  });
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection", {
    feature: "server",
    error,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    feature: "server",
    error,
  });

  server.close(() => {
    process.exit(1);
  });
});
