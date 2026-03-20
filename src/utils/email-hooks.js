"use strict";

/**
 * email-hooks.js
 *
 * Helpery do wywoływania powiadomień email z tras workflow i documents.
 * Importuj i wywołuj po pomyślnym zapisie do bazy — nigdy nie blokują odpowiedzi.
 *
 * UŻYCIE w routes/workflow.js — po przypisaniu zadania:
 *
 *   const emailHooks = require('../utils/email-hooks');
 *   // ...po INSERT workflow_task:
 *   emailHooks.onTaskAssigned({ db, task: newTask, assignerUser: req.user }).catch(() => {});
 *
 * UŻYCIE w routes/documents.js — po zmianie statusu:
 *
 *   emailHooks.onStatusChanged({ db, document: updatedDoc, oldStatus, changerUser: req.user }).catch(() => {});
 *
 * UŻYCIE w routes/workflow.js — po ukończeniu/odrzuceniu zadania:
 *
 *   emailHooks.onTaskCompleted({ db, task, completedByUser: req.user, comment }).catch(() => {});
 *   emailHooks.onTaskRejected({ db, task, rejectedByUser: req.user, comment }).catch(() => {});
 *
 * UŻYCIE w routes/admin/users.js — po dodaniu użytkownika:
 *
 *   emailHooks.onUserInvited({ newUser, invitedByUser: req.user }).catch(() => {});
 */

const email = require("./email");
const logger = require("./logger");

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getUserEmail(db, userId) {
  if (!userId) return null;
  const { rows } = await db.query(
    "SELECT email, display_name FROM users WHERE id = $1",
    [userId],
  );
  return rows[0] || null;
}

async function getDocumentOwner(db, documentId) {
  const { rows } = await db.query(
    `SELECT u.email, u.display_name, d.name AS doc_name, d.doc_number
     FROM documents d
     JOIN users u ON u.id = d.owner_id
     WHERE d.id = $1`,
    [documentId],
  );
  return rows[0] || null;
}

// ─── Hook: zadanie przypisane ────────────────────────────────────────────────

/**
 * Wywołaj po INSERT do workflow_tasks.
 * @param {object} db       - instancja bazy (require('../config/database'))
 * @param {object} task     - nowy wiersz z workflow_tasks (musi mieć assigned_to, task_type, document_id, due_date)
 * @param {object} assignerUser - req.user (musi mieć id, display_name)
 */
async function onTaskAssigned({ db, task, assignerUser }) {
  try {
    const assignee = await getUserEmail(db, task.assigned_to);
    if (!assignee?.email) return;

    const { rows } = await db.query(
      "SELECT name, doc_number FROM documents WHERE id = $1",
      [task.document_id],
    );
    const doc = rows[0];
    if (!doc) return;

    await email.sendTaskAssigned({
      to: assignee.email,
      assigneeName: assignee.display_name,
      taskType: task.task_type,
      documentName: doc.name,
      docNumber: doc.doc_number,
      assignerName: assignerUser.display_name || assignerUser.email,
      dueDate: task.due_date,
      documentId: task.document_id,
    });
  } catch (err) {
    logger.error("emailHooks.onTaskAssigned failed", { error: err.message });
  }
}

// ─── Hook: status dokumentu zmieniony ───────────────────────────────────────

/**
 * Wywołaj po PATCH /documents/:id (zmiana statusu).
 * Powiadamia właściciela dokumentu oraz wszystkich użytkowników z aktywnym zadaniem.
 */
async function onStatusChanged({ db, document, oldStatus, changerUser }) {
  if (oldStatus === document.status) return;

  try {
    const changerName = changerUser.display_name || changerUser.email;

    // Zbiór adresatów: właściciel + osoby z aktywnymi taskami
    const { rows: recipients } = await db.query(
      `SELECT DISTINCT u.email, u.display_name
       FROM users u
       WHERE u.id = $1
       UNION
       SELECT DISTINCT u.email, u.display_name
       FROM workflow_tasks wt
       JOIN users u ON u.id = wt.assigned_to
       WHERE wt.document_id = $2
         AND wt.task_status IN ('pending','in_progress')
         AND u.id != $1`,
      [document.owner_id, document.id],
    );

    for (const recipient of recipients) {
      if (!recipient.email) continue;
      // Nie wysyłaj do osoby która sama zmieniła status
      if (recipient.email === changerUser.email) continue;

      await email.sendDocumentStatusChanged({
        to: recipient.email,
        recipientName: recipient.display_name,
        documentName: document.name,
        docNumber: document.doc_number,
        oldStatus,
        newStatus: document.status,
        changedByName: changerName,
        documentId: document.id,
      });
    }
  } catch (err) {
    logger.error("emailHooks.onStatusChanged failed", { error: err.message });
  }
}

// ─── Hook: zadanie ukończone ─────────────────────────────────────────────────

async function onTaskCompleted({ db, task, completedByUser, comment }) {
  try {
    const owner = await getDocumentOwner(db, task.document_id);
    if (!owner?.email) return;
    // Nie wysyłaj jeśli właściciel sam ukończył swoje zadanie
    if (owner.email === completedByUser.email) return;

    await email.sendTaskCompleted({
      to: owner.email,
      ownerName: owner.display_name,
      taskType: task.task_type,
      documentName: owner.doc_name,
      docNumber: owner.doc_number,
      completedByName: completedByUser.display_name || completedByUser.email,
      comment,
    });
  } catch (err) {
    logger.error("emailHooks.onTaskCompleted failed", { error: err.message });
  }
}

// ─── Hook: zadanie odrzucone ─────────────────────────────────────────────────

async function onTaskRejected({ db, task, rejectedByUser, comment }) {
  try {
    const owner = await getDocumentOwner(db, task.document_id);
    if (!owner?.email) return;

    await email.sendTaskRejected({
      to: owner.email,
      ownerName: owner.display_name,
      documentName: owner.doc_name,
      docNumber: owner.doc_number,
      rejectedByName: rejectedByUser.display_name || rejectedByUser.email,
      comment,
    });
  } catch (err) {
    logger.error("emailHooks.onTaskRejected failed", { error: err.message });
  }
}

// ─── Hook: nowy użytkownik ───────────────────────────────────────────────────

async function onUserInvited({ newUser, invitedByUser }) {
  try {
    if (!newUser.email) return;
    await email.sendUserInvitation({
      to: newUser.email,
      displayName: newUser.display_name || newUser.email,
      invitedByName: invitedByUser.display_name || invitedByUser.email,
    });
  } catch (err) {
    logger.error("emailHooks.onUserInvited failed", { error: err.message });
  }
}

// ─── Hook: dokument podpisany przez Signus (webhook) ─────────────────────────

async function onDocumentSigned({ db, document, signedByName }) {
  try {
    const owner = await getDocumentOwner(db, document.id);
    if (!owner?.email) return;

    await email.sendDocumentSigned({
      to: owner.email,
      recipientName: owner.display_name,
      documentName: document.name || owner.doc_name,
      docNumber: document.doc_number || owner.doc_number,
      signedByName: signedByName || "Signus",
    });
  } catch (err) {
    logger.error("emailHooks.onDocumentSigned failed", { error: err.message });
  }
}

module.exports = {
  onTaskAssigned,
  onStatusChanged,
  onTaskCompleted,
  onTaskRejected,
  onUserInvited,
  onDocumentSigned,
};
