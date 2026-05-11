"use strict";

const router = require("express").Router();
const { query } = require("express-validator");
const audit = require("../services/auditService");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/errorHandler");

router.use(requireAuth, requireAdmin);

// GET /api/admin/logs
router.get(
  "/",
  [
    query("date_from").optional().isISO8601(),
    query("date_to").optional().isISO8601(),
    query("user_id").optional().isUUID(),
    query("user_email").optional().isString().trim(),
    query("document_id").optional().isUUID(),
    query("document_name").optional().isString().trim(),
    query("action").optional().isString().trim(),
    query("search").optional().isString().trim(),
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await audit.queryLogs({
        tenantId:     req.tenantId,
        dateFrom:     req.query.date_from,
        dateTo:       req.query.date_to,
        userId:       req.query.user_id,
        userEmail:    req.query.user_email,
        documentId:   req.query.document_id,
        documentName: req.query.document_name,
        action:       req.query.action,
        search:       req.query.search,
        page:         req.query.page || 1,
        limit:        req.query.limit || 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/admin/logs/actions — list all distinct action types for filter dropdown
router.get("/actions", async (req, res, next) => {
  try {
    const { db } = require("../config/database");
    const { rows } = await require("../config/database").query(
      `SELECT unnest(enum_range(NULL::audit_action))::text AS action ORDER BY action`,
    );
    res.json(rows.map((r) => r.action));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
