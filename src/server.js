"use strict";

const app          = require("./app");
const config       = require("./config");
const logger       = require("./utils/logger");
const db           = require("./config/database");
const pubsubPoller = require("./services/pubsubPoller");
const { migrate }  = require("./db/migrate");
const { startDailyScoresJob } = require("./jobs/daily-scores");

async function start() {
  // ─── Startup security checks ──────────────────────────────
  if (config.isProd && config.jwt.secret.startsWith('dev_secret')) {
    logger.error('FATAL: Production running with default dev JWT secret — set JWT_SECRET env var');
    process.exit(1);
  }

  // ─── Run migrations before accepting traffic ──────────────
  try {
    logger.info("Running DB migrations…");
    await migrate();
    logger.info("DB migrations OK");
  } catch (err) {
    logger.error("DB migration failed — aborting startup", { error: err.message });
    process.exit(1);
  }

  // ─── Start HTTP server ────────────────────────────────────
  const server = app.listen(config.port, () => {
    logger.info(`CRMtree backend running`, {
      port: config.port,
      env: config.env,
      appUrl: config.appUrl,
    });
    pubsubPoller.start();
    startDailyScoresJob();
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
    setTimeout(() => {
      logger.error("Shutdown timeout exceeded, forcing exit.");
      process.exit(1);
    }, 15000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  return server;
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
});

start().catch((err) => {
  logger.error("Startup failed", { error: err.message });
  process.exit(1);
});
