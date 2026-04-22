"use strict";

const app          = require("./app");
const config       = require("./config");
const logger       = require("./utils/logger");
const db           = require("./config/database");
const pubsubPoller = require("./services/pubsubPoller");

const server = app.listen(config.port, () => {
  logger.info(`worktrips.doc backend running`, {
    port: config.port,
    env: config.env,
    appUrl: config.appUrl,
  });

  // Uruchom pull-based Pub/Sub poller (zastępuje push webhook)
  pubsubPoller.start();
});

// ─── Graceful shutdown ────────────────────────────────────
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully…`);
  pubsubPoller.stop();
  server.close(async () => {
    try {
      await db.pool.end();
      logger.info("DB pool closed. Goodbye.");
      process.exit(0);
    } catch (err) {
      logger.error("Error during shutdown", { error: err.message });
      process.exit(1);
    }
  });

  // Force exit after 15s
  setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit.");
    process.exit(1);
  }, 15000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
});

module.exports = server;
