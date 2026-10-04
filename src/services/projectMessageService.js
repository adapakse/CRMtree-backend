'use strict';
// services/projectMessageService.js
//
// Chat threads of the Projects module: the general project thread
// (taskId = null) and one thread per task. Who may open a thread is decided
// by the caller (project membership / task visibility); every member who
// can open a thread may also write in it. Messages are never edited or deleted.

const db = require('../config/database');

const THREAD_PAGE_SIZE = 200;

// Returns the newest THREAD_PAGE_SIZE messages of the thread, oldest first.
async function listMessages({ projectId, taskId = null }) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT m.id, m.body, m.created_at, m.author_id, u.display_name AS author_name
       FROM project_messages m
       LEFT JOIN users u ON u.id = m.author_id
       WHERE m.project_id = $1 AND m.task_id IS NOT DISTINCT FROM $2
       ORDER BY m.created_at DESC
       LIMIT ${THREAD_PAGE_SIZE}
     ) newest
     ORDER BY created_at`,
    [projectId, taskId],
  );
  return rows;
}

async function postMessage({ tenantId, projectId, taskId = null, author, body }) {
  const { rows: [message] } = await db.query(
    `INSERT INTO project_messages (tenant_id, project_id, task_id, author_id, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, body, created_at, author_id`,
    [tenantId, projectId, taskId, author.id, body],
  );
  return { ...message, author_name: author.display_name };
}

module.exports = { listMessages, postMessage };
