"use strict";

const { createLogger, format, transports } = require("winston");
const config = require("../config");

const logger = createLogger({
  level: config.isDev ? "debug" : "info",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    config.isDev
      ? format.combine(format.colorize(), format.simple())
      : format.json(),
  ),
  transports: [new transports.Console()],
  exitOnError: false,
});

module.exports = logger;
