"use strict";

const router = require("express").Router({ mergeParams: true });
const { body, param } = require("express-validator");
const db = require("../config/database");
const audit = require("../services/auditService");
const perms = require("../services/permissionService");
const emailSvc = require("../services/emailService");
const { requireAuth } = require("../middleware/auth");
const { validate, injectAuditContext } = require("../middleware/errorHandler");

router.use(requireAuth, injectAuditContext);

async function loadDoc(id) {
  const { rows } = await db.query(
    "SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  return rows[0] || null;
}

// ────────────────────────────────────────────────────────────
// GET /api/documents/:documentId/workflow — task list (timeline)
// ────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const doc = await loadDoc(req.params.documentId);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await perms.assertCanRead(req.user.id, doc);

    const { rows } = await db.query(
      `SELECT wt.*,
              assigner.display_name AS assigner_name, assigner.email AS assigner_email,
              assignee.display_name AS assignee_name, assignee.email AS assignee_email
       FROM workflow_tasks wt
       LEFT JOIN users assigner ON assigner.id = wt.assigned_by
       LEFT JOIN users assignee ON assignee.id = wt.assigned_to
       WHERE wt.document_id = $1
       ORDER BY wt.created_at DESC`,
      [doc.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/documents/:documentId/workflow — assign task
// ────────────────────────────────────────────────────────────
router.post(
  "/",
  [
    body("assigned_to").notEmpty().isUUID(),
    body("task_type").notEmpty().isIn(["read", "edit", "approve", "sign"]),
    body("message").optional().isString().trim().isLength({ max: 2000 }),
    body("due_date").optional({ nullable: true }).isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const doc = await loadDoc(req.params.documentId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      await perms.assertCanFull(req.user.id, doc);

      const { assigned_to, task_type, message, due_date } = req.body;

      // Verify assignee exists
      const { rows: userRows } = await db.query(
        "SELECT id, display_name, email FROM users WHERE id = $1 AND is_active = TRUE",
        [assigned_to],
      );
      if (!userRows.length)
        return res.status(400).json({ error: "Assignee not found" });
      const assignee = userRows[0];

      let taskRow;
      await db.transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO workflow_tasks
             (document_id, assigned_by, assigned_to, task_type, message, due_date, task_status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending')
           RETURNING *`,
          [
            doc.id,
            req.user.id,
            assigned_to,
            task_type,
            message || null,
            due_date || null,
          ],
        );
        taskRow = rows[0];

        // Auto-update document status
        const statusMap = { edit: "being_edited", sign: "being_signed" };
        if (statusMap[task_type]) {
          await client.query(
            `UPDATE documents SET status = $1::doc_status WHERE id = $2`,
            [statusMap[task_type], doc.id],
          );
        }

        await audit.log({
          user: req.user,
          document: doc,
          action: "workflow_task_created",
          afterState: {
            task_type,
            assigned_to,
            assignee_name: assignee.display_name,
            message,
          },
          metadata: { task_id: taskRow.id },
          ipAddress: req.auditContext?.ipAddress,
          client,
        });
      });

      // Send email notification to assignee
      await emailSvc.sendWorkflowAssignment({
        to: assignee.email,
        assigneeName: assignee.display_name,
        assignerName: req.user.display_name,
        document: { id: doc.id, docNumber: doc.doc_number, name: doc.name },
        taskType: task_type,
        message,
        dueDate: due_date,
      });

      res.status(201).json(taskRow);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// PATCH /api/documents/:documentId/workflow/:taskId — update task
// ────────────────────────────────────────────────────────────
router.patch(
  "/:taskId",
  [
    param("taskId").isUUID(),
    body("task_status")
      .optional()
      .isIn(["pending", "in_progress", "completed", "cancelled"]),
    body("message").optional().isString().trim(),
    body("due_date").optional({ nullable: true }).isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const doc = await loadDoc(req.params.documentId);
      if (!doc) return res.status(404).json({ error: "Document not found" });

      const { rows: taskRows } = await db.query(
        "SELECT * FROM workflow_tasks WHERE id = $1 AND document_id = $2",
        [req.params.taskId, doc.id],
      );
      if (!taskRows.length)
        return res.status(404).json({ error: "Task not found" });
      const task = taskRows[0];

      // Assignee can update status; assigner or admin can cancel
      const isAssignee = task.assigned_to === req.user.id;
      const canManage = await perms.canFull(req.user.id, doc);
      if (!isAssignee && !canManage) {
        return res.status(403).json({ error: "Access denied" });
      }

      const updates = [];
      const params = [];
      let p = 1;

      if (req.body.task_status !== undefined) {
        updates.push(`task_status = $${p++}::workflow_task_status`);
        params.push(req.body.task_status);
        if (req.body.task_status === "completed") {
          updates.push(`completed_at = NOW()`, `completed_by = $${p++}`);
          params.push(req.user.id);
        }
      }
      if (req.body.message !== undefined) {
        updates.push(`message = $${p++}`);
        params.push(req.body.message);
      }
      if (req.body.due_date !== undefined) {
        updates.push(`due_date = $${p++}`);
        params.push(req.body.due_date || null);
      }

      params.push(task.id);
      const { rows: updated } = await db.query(
        `UPDATE workflow_tasks SET ${updates.join(", ")} WHERE id = $${p} RETURNING *`,
        params,
      );

      const actionName =
        req.body.task_status === "completed"
          ? "workflow_task_completed"
          : req.body.task_status === "cancelled"
            ? "workflow_task_cancelled"
            : "workflow_task_created";

      await audit.log({
        user: req.user,
        document: doc,
        action: actionName,
        beforeState: { task_status: task.task_status },
        afterState: req.body,
        metadata: { task_id: task.id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.json(updated[0]);
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────
// DELETE /api/documents/:documentId/workflow/:taskId — cancel task
// ────────────────────────────────────────────────────────────
router.delete(
  "/:taskId",
  [param("taskId").isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const doc = await loadDoc(req.params.documentId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      await perms.assertCanFull(req.user.id, doc);

      const { rows } = await db.query(
        `UPDATE workflow_tasks SET task_status = 'cancelled'::workflow_task_status
       WHERE id = $1 AND document_id = $2 RETURNING *`,
        [req.params.taskId, doc.id],
      );
      if (!rows.length)
        return res.status(404).json({ error: "Task not found" });

      await audit.log({
        user: req.user,
        document: doc,
        action: "workflow_task_cancelled",
        metadata: { task_id: req.params.taskId },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.json({ message: "Task cancelled", id: req.params.taskId });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/workflow/all-tasks — all tasks (kanban)

router.get("/all-tasks", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT wt.*,
              d.doc_number, d.name AS document_name, d.status AS document_status,
              assignee.display_name AS assignee_name,
              assigner.display_name AS assigner_name,
              gp.name AS group_name
       FROM workflow_tasks wt
       JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL
       LEFT JOIN users assignee ON assignee.id = wt.assigned_to
       LEFT JOIN users assigner ON assigner.id = wt.assigned_by
       LEFT JOIN group_profiles gp ON gp.id = d.group_id
       ORDER BY wt.created_at DESC`,
      [],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/workflow/my-tasks — current user's open tasks
// ────────────────────────────────────────────────────────────
router.get("/my-tasks", async (req, res, next) => {
  // This is mounted at /api/workflow/my-tasks (not under /:documentId)
  // See app.js for the separate mount
  try {
    const { rows } = await db.query(
      `SELECT wt.*,
              d.doc_number, d.name AS document_name, d.status AS document_status,
              assigner.display_name AS assigner_name,
              gp.name AS group_name
       FROM workflow_tasks wt
       JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL
       LEFT JOIN users assigner ON assigner.id = wt.assigned_by
       LEFT JOIN group_profiles gp ON gp.id = d.group_id
       WHERE wt.assigned_to = $1 AND wt.task_status IN ('pending','in_progress')
       ORDER BY wt.created_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
