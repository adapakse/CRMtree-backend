"use strict";

const { validationResult } = require("express-validator");
const logger = require("../utils/logger");

// ─── Validation error handler ─────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Validation failed",
      details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

// ─── Global error handler (must be last middleware) ───────
function errorHandler(err, req, res, next) {
  // eslint-disable-line no-unused-vars
  // Multer errors (file type / size)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Plik jest za duży. Maksymalny rozmiar to 50 MB.' });
  }
  if (err.message && err.message.startsWith('File type not allowed')) {
    return res.status(400).json({ error: `Niedozwolony typ pliku. Dozwolone: PDF, DOCX, DOC.` });
  }
  const status = err.status || 500;
  const isDev = process.env.NODE_ENV === "development";

  if (status >= 500) {
    logger.error("Unhandled error", {
      message: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      userId: req.user?.id,
    });
  }

  res.status(status).json({
    error: status < 500 ? err.message : "Internal server error",
    ...(isDev && status >= 500 ? { stack: err.stack } : {}),
  });
}

// ─── Audit context injector ───────────────────────────────
function injectAuditContext(req, res, next) {
  req.auditContext = {
    ipAddress: req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim(),
    userAgent: req.headers["user-agent"],
  };
  next();
}

// ─── Not found handler ────────────────────────────────────
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

module.exports = { validate, errorHandler, injectAuditContext, notFound };
