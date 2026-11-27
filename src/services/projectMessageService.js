'use strict';
// services/projectMessageService.js
//
// Chat threads of the Projects module: the general project thread
// (taskId = null) and one thread per task. Who may open a thread is decided
// by the caller (project membership / task visibility); every member who
// can open a thread may also write in it. Messages are never edited or deleted.
//
// Read state is one marker per person and thread (project_message_reads):
// how far that person has read. Unread counts, the "read" ticks of a message
// and the badge of the phone's app icon all come from it.

const db = require('../config/database');
const pushService = require('./pushService');
const logger = require('../utils/logger');

const THREAD_PAGE_SIZE = 200;
const PUSH_EXCERPT_LENGTH = 140;

// The members a thread is addressed to, with how far each has read it. A task
// thread is hidden from an external participant who is not assigned to the task.
const THREAD_AUDIENCE_SQL = `
  SELECT member.user_id, u.display_name, r.last_read_at
  FROM project_members member
  JOIN users u ON u.id = member.user_id AND u.is_active
  LEFT JOIN project_message_reads r
    ON r.user_id = member.user_id AND r.project_id = member.project_id
   AND r.task_id IS NOT DISTINCT FROM $2::uuid
  WHERE member.project_id = $1
    AND ($2::uuid IS NULL OR member.role <> 'external_participant' OR EXISTS (
      SELECT 1 FROM project_task_assignees a WHERE a.task_id = $2::uuid AND a.user_id = member.user_id))
  ORDER BY u.last_name, u.first_name`;

async function listThreadAudience({ projectId, taskId = null }) {
  const { rows } = await db.query(THREAD_AUDIENCE_SQL, [projectId, taskId]);
  return rows;
}

// Who of the audience has read the message, and whether that is everyone it
// was addressed to. The author is not a reader of an own message.
function withReadState(message, audience) {
  const recipients = audience.filter((member) => member.user_id !== message.author_id);
  const readers = recipients.filter(
    (member) => member.last_read_at && member.last_read_at >= message.created_at,
  );
  return {
    ...message,
    read_by: readers.map((member) => ({ user_id: member.user_id, display_name: member.display_name })),
    is_read_by_all: recipients.length > 0 && readers.length === recipients.length,
  };
}

// Returns the newest THREAD_PAGE_SIZE messages of the thread, oldest first.
async function listMessages({ projectId, taskId = null }) {
  const [{ rows }, audience] = await Promise.all([
    db.query(
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
    ),
    listThreadAudience({ projectId, taskId }),
  ]);
  return rows.map((message) => withReadState(message, audience));
}

/**
 * Moves the person's read marker of the thread forward — to the given message
 * (the newest one the client has shown) or, without it, to now. The marker
 * never moves back.
 */
async function markThreadRead({ tenantId, projectId, taskId = null, userId, lastMessageId = null }) {
  const conflictTarget = taskId
    ? '(user_id, task_id) WHERE task_id IS NOT NULL'
    : '(user_id, project_id) WHERE task_id IS NULL';
  await db.query(
    `INSERT INTO project_message_reads (tenant_id, project_id, task_id, user_id, last_read_at)
     VALUES ($1, $2, $3::uuid, $4, COALESCE(
       (SELECT m.created_at FROM project_messages m
         WHERE m.id = $5::uuid AND m.project_id = $2 AND m.task_id IS NOT DISTINCT FROM $3::uuid),
       now()))
     ON CONFLICT ${conflictTarget}
     DO UPDATE SET last_read_at = GREATEST(project_message_reads.last_read_at, EXCLUDED.last_read_at)`,
    [tenantId, projectId, taskId, userId, lastMessageId],
  );
}

async function postMessage({ tenantId, projectId, taskId = null, author, body }) {
  const { rows: [message] } = await db.query(
    `INSERT INTO project_messages (tenant_id, project_id, task_id, author_id, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, body, created_at, author_id`,
    [tenantId, projectId, taskId, author.id, body],
  );
  // Whoever writes in a thread has read it up to that message.
  await markThreadRead({ tenantId, projectId, taskId, userId: author.id, lastMessageId: message.id });
  return { ...message, author_name: author.display_name, read_by: [], is_read_by_all: false };
}

// Unread messages per person and thread, only in projects the person is a
// member of and only in threads the person may open. Messages from before
// the person joined the project do not count.
async function countUnreadByThread({ tenantId, userIds }) {
  const { rows } = await db.query(
    `SELECT me.user_id, m.project_id, m.task_id, COUNT(*)::int AS unread
     FROM project_messages m
     JOIN project_members me ON me.project_id = m.project_id AND me.user_id = ANY($2::uuid[])
     LEFT JOIN project_message_reads r
       ON r.user_id = me.user_id AND r.project_id = m.project_id
      AND r.task_id IS NOT DISTINCT FROM m.task_id
     WHERE m.tenant_id = $1
       AND m.author_id IS DISTINCT FROM me.user_id
       AND m.created_at > GREATEST(COALESCE(r.last_read_at, me.created_at), me.created_at)
       AND (m.task_id IS NULL OR me.role <> 'external_participant' OR EXISTS (
         SELECT 1 FROM project_task_assignees a WHERE a.task_id = m.task_id AND a.user_id = me.user_id))
     GROUP BY me.user_id, m.project_id, m.task_id`,
    [tenantId, userIds],
  );
  return rows;
}

/**
 * The person's unread chat messages: the total for the menu and the app icon,
 * and per project — the general thread and each task thread apart.
 */
async function getUnreadSummary({ tenantId, userId }) {
  const rows = await countUnreadByThread({ tenantId, userIds: [userId] });
  const projects = new Map();
  let total = 0;
  for (const row of rows) {
    total += row.unread;
    if (!projects.has(row.project_id)) {
      projects.set(row.project_id, { project_id: row.project_id, unread: 0, general_unread: 0, tasks: [] });
    }
    const project = projects.get(row.project_id);
    project.unread += row.unread;
    if (row.task_id) project.tasks.push({ task_id: row.task_id, unread: row.unread });
    else project.general_unread = row.unread;
  }
  return { total, projects: [...projects.values()] };
}

/**
 * Pushes a new message to the phones of everyone else in the thread, with the
 * recipient's unread total as the number on the app icon. Best effort: never
 * throws, and does nothing while push is not configured.
 */
async function notifyNewMessage({ tenantId, project, task = null, author, message, push = pushService }) {
  if (!push.isConfigured()) return;
  try {
    const audience = await listThreadAudience({ projectId: project.id, taskId: task?.id || null });
    const recipientIds = audience.map((member) => member.user_id).filter((id) => id !== author.id);
    if (!recipientIds.length) return;
    const unreadRows = await countUnreadByThread({ tenantId, userIds: recipientIds });
    const badgeByUserId = {};
    for (const row of unreadRows) badgeByUserId[row.user_id] = (badgeByUserId[row.user_id] || 0) + row.unread;
    const excerpt = message.body.length > PUSH_EXCERPT_LENGTH
      ? `${message.body.slice(0, PUSH_EXCERPT_LENGTH - 1)}…`
      : message.body;
    await push.sendToUsers({
      userIds: recipientIds,
      kind: 'projectMessage',
      params: {
        threadName: task ? `${project.key}-${task.task_number} ${task.name}` : project.name,
        authorName: author.display_name || author.email,
        excerpt,
      },
      data: {
        source_type: 'project_message', project_id: project.id,
        ...(task ? { task_id: task.id } : {}),
      },
      badgeByUserId,
    });
  } catch (error) {
    // The message is saved; a notification that could not be prepared must not fail the request.
    logger.warn('[project chat] Push about a new message failed', { error: error.message });
  }
}

/**
 * After the person has read a thread: brings the number on the app icon of
 * their iPhones down to what is still unread. Best effort, like every push.
 */
async function syncIconBadge({ tenantId, userId, push = pushService }) {
  if (!push.isConfigured()) return;
  try {
    const { total } = await getUnreadSummary({ tenantId, userId });
    await push.syncIconBadge({ userId, badge: total });
  } catch (error) {
    logger.warn('[project chat] Updating the icon badge failed', { error: error.message });
  }
}

module.exports = { listMessages, postMessage, markThreadRead, getUnreadSummary, notifyNewMessage, syncIconBadge };
