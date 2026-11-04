"use strict";

/**
 * email.js — system e-mails of CRMtree, sent through ZeptoMail over SMTP.
 *
 * Every notification (reminders, the daily digest, project notifications,
 * documents) goes through sendMail() below. Settings: config.email (EMAIL_*).
 * Until 2026-10 this used the Gmail API with a Google service account
 * impersonating noreply@worktrips.com; Google refused it in production
 * (unauthorized_client), so no system e-mail went out. Adam chose ZeptoMail
 * (decision of 2026-10-22): the crmtree.pl mailboxes stay on Zoho Mail, and a
 * transactional service copes with the 09:00 peak of digests that would trip
 * an ordinary mailbox's hourly limit.
 */

const nodemailer = require("nodemailer");
const config = require("../config");
const db = require("../config/database");
const logger = require("./logger");
const { tenantAppUrl } = require("../config/tenantHost");
const { translate, formatDate, formatDateOnly, formatDateTime, supportedOrDefault } = require("./i18n");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { host, port, user, password } = config.email.smtp;
  if (!host || !password) {
    throw new Error("Brak konfiguracji wysyłki maili (EMAIL_SMTP_HOST, EMAIL_SMTP_PASSWORD)");
  }
  transporter = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; 587 starts plain and must upgrade with STARTTLS.
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass: password },
  });
  return transporter;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Główna funkcja wysyłki ───────────────────────────────────────────────────

async function sendMail({ to, subject, html, text }) {
  if (!to) {
    logger.warn("email.sendMail: brak adresata, pomijam");
    return;
  }

  // W trybie dev tylko loguj — nie wysyłaj
  if (config.isDev && !config.email.sendInDev) {
    logger.info(
      `[DEV] Email NIE wysłany (ustaw EMAIL_SEND_IN_DEV=true aby wysyłać w dev)`,
      {
        to,
        subject,
      },
    );
    return;
  }

  try {
    await getTransporter().sendMail({
      from: { name: config.email.fromName, address: config.email.from },
      to,
      subject,
      html,
      text: text || stripHtml(html),
    });

    logger.info(`Email wysłany`, { to, subject });
  } catch (err) {
    // Nie rzucamy — błąd emaila nie powinien blokować operacji biznesowej
    logger.error(`Błąd wysyłki emaila`, { to, subject, error: err.message });
  }
}

// ─── Message templates ───────────────────────────────────────────────────────
//
// Every text comes from src/i18n/emails/<lang>.json. Each send* function takes
// the `locale` of its recipient (see resolveLocale in config/locales.js); a
// missing or unsupported locale gives the Polish mail.

const BASE_URL = config.frontendUrl;

/**
 * Links in a mail point at the recipient's company address
 * ({slug}.crmtree.pl), not the shared app.crmtree.pl. One e-mail can have
 * accounts in several companies, and signing in on the shared host picks one
 * of them, so a link there opened a record of another company as "not found".
 * Signing in on the company's own host always uses the account in that company.
 */
async function appUrlFor(tenantId) {
  if (!tenantId) return BASE_URL;
  try {
    const { rows } = await db.query("SELECT slug FROM tenants WHERE id = $1", [tenantId]);
    return tenantAppUrl(rows[0]?.slug, BASE_URL);
  } catch (err) {
    logger.warn("email.appUrlFor: no company address, using the shared one", { tenantId, error: err.message });
    return BASE_URL;
  }
}

// The company's time zone for hours printed in a mail. Never throws: a lookup
// failure falls back to Warsaw, where most companies are, instead of losing the mail.
const DEFAULT_TIME_ZONE = "Europe/Warsaw";
async function timeZoneFor(tenantId) {
  if (!tenantId) return DEFAULT_TIME_ZONE;
  try {
    const { rows } = await db.query("SELECT time_zone FROM tenants WHERE id = $1", [tenantId]);
    return rows[0]?.time_zone || DEFAULT_TIME_ZONE;
  } catch (err) {
    logger.warn("email.timeZoneFor: no company time zone, using Warsaw", { tenantId, error: err.message });
    return DEFAULT_TIME_ZONE;
  }
}

function emailTexts(locale) {
  return (key, params) => translate(locale, `emails.${key}`, params);
}

/**
 * Escape user-entered text before inserting it into email HTML.
 * htmlText() additionally keeps line breaks as <br>.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlText(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

// Values stored in the database → key of their label in the translation files.
// A value missing here is printed as it is.
const DOCUMENT_TASK_BADGES = {
  read: "badge-blue",
  edit: "badge-orange",
  approve: "badge-purple",
  sign: "badge-purple",
};

const DOCUMENT_STATUSES = {
  new: { key: "new", badge: "badge-blue" },
  being_edited: { key: "beingEdited", badge: "badge-orange" },
  being_signed: { key: "beingSigned", badge: "badge-purple" },
  being_approved: { key: "beingApproved", badge: "badge-purple" },
  signed: { key: "signed", badge: "badge-green" },
  completed: { key: "completed", badge: "badge-green" },
  hold: { key: "hold", badge: "badge-orange" },
  rejected: { key: "rejected", badge: "badge-red" },
};

const ACTIVITY_TYPE_KEYS = {
  call: "call",
  email: "email",
  meeting: "meeting",
  note: "note",
  doc_sent: "docSent",
  training: "training",
  qbr: "qbr",
  opportunity: "opportunity",
};

// Only the reminder mail labels "task"; the assignment mail has always printed that type raw.
const REMINDER_ACTIVITY_TYPE_KEYS = { ...ACTIVITY_TYPE_KEYS, task: "task" };

const ABSENCE_REASON_KEYS = {
  vacation: "vacation",
  sick_leave: "sickLeave",
  other: "other",
};

const REMINDER_DAYS_BEFORE = { "1d_before": 1, "2d_before": 2, "3d_before": 3 };

function activityTypeLabel(t, keysByType, activityType) {
  const key = keysByType[activityType];
  return key ? t(`activityTypes.${key}`) : activityType;
}

// CRM activities and project tasks word the "on the due date" reminder differently.
function reminderLabel(t, reminderType, atDueKey) {
  if (reminderType === "at_due") return t(`reminderTypes.${atDueKey}`);
  if (reminderType === "custom") return t("reminderTypes.custom");
  const days = REMINDER_DAYS_BEFORE[reminderType];
  return days ? t("reminderTypes.daysBefore", { count: days }) : "";
}

/**
 * Shared HTML layout with the CRMtree branding.
 */
function template(locale, content) {
  const t = emailTexts(locale);
  return `<!DOCTYPE html>
<html lang="${supportedOrDefault(locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin:0; padding:0; background:#F4F4F5; font-family:'Segoe UI',Arial,sans-serif; }
    .wrap { max-width:560px; margin:32px auto; background:white; border-radius:12px;
            border:1px solid #E4E4E7; overflow:hidden; }
    .header { background:#1F2933; padding:20px 28px; display:flex; align-items:center; }
    .logo { font-size:17px; font-weight:700; color:white; letter-spacing:-.3px; }
    .logo span { color:#3BAA5D; }
    .body { padding:28px 28px 20px; color:#27272A; font-size:14px; line-height:1.6; }
    .body h2 { margin:0 0 12px; font-size:18px; color:#18181B; }
    .info-box { background:#FAFAFA; border:1px solid #E4E4E7; border-radius:8px;
                padding:14px 16px; margin:16px 0; font-size:13px; }
    .info-row { display:flex; gap:8px; padding:4px 0; }
    .info-label { color:#71717A; min-width:110px; }
    .info-val { color:#18181B; font-weight:500; }
    .btn { display:inline-block; background:#3BAA5D; color:white; text-decoration:none;
           padding:11px 22px; border-radius:8px; font-weight:600; font-size:13px;
           margin:16px 0 8px; }
    .badge { display:inline-block; padding:2px 8px; border-radius:12px;
             font-size:11px; font-weight:600; }
    .badge-blue   { background:#EFF6FF; color:#1D4ED8; }
    .badge-purple { background:#FDF4FF; color:#7E22CE; }
    .badge-orange { background:#FFF0E8; color:#D4521A; }
    .badge-green  { background:#F0FDF4; color:#15803D; }
    .badge-red    { background:#FFF1F2; color:#BE123C; }
    .footer { background:#F4F4F5; padding:14px 28px; font-size:11px; color:#A1A1AA;
              border-top:1px solid #E4E4E7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <span class="logo">CRM<span>tree</span></span>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      ${t("layout.footerAutomatic")}<br>
      ${t("layout.footerNoReply")}
    </div>
  </div>
</body>
</html>`;
}

// ─── Event mails ─────────────────────────────────────────────────────────────
// All of them send through module.exports.sendMail so tests can spy on it.

/**
 * A document workflow task was assigned to the user.
 */
async function sendTaskAssigned({
  to,
  locale,
  assigneeName,
  taskType,
  documentName,
  docNumber,
  assignerName,
  dueDate,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const taskBadge = DOCUMENT_TASK_BADGES[taskType] || "badge-blue";
  const taskTypeLabel = DOCUMENT_TASK_BADGES[taskType] ? t(`documentTaskTypes.${taskType}`) : taskType;
  const url = `${appUrl}/documents`;

  await module.exports.sendMail({
    to,
    subject: t("taskAssigned.subject", { documentName }),
    html: template(locale, `
      <h2>${t("taskAssigned.heading")}</h2>
      <p>${t("common.greeting", { name: assigneeName })}</p>
      <p>${t("taskAssigned.intro", { assignerName })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t("labels.document")}</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.number")}</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.taskType")}</span>
          <span class="info-val"><span class="badge ${taskBadge}">${taskTypeLabel}</span></span>
        </div>
        ${
          dueDate
            ? `<div class="info-row">
          <span class="info-label">${t("labels.dueDate")}</span>
          <span class="info-val">${formatDate(locale, dueDate, {})}</span>
        </div>`
            : ""
        }
        <div class="info-row">
          <span class="info-label">${t("labels.assigner")}</span>
          <span class="info-val">${assignerName}</span>
        </div>
      </div>
      <a href="${url}" class="btn">${t("common.openDocument")}</a>
    `),
  });
}

/**
 * The status of a document changed.
 */
async function sendDocumentStatusChanged({
  to,
  locale,
  recipientName,
  documentName,
  docNumber,
  oldStatus,
  newStatus,
  changedByName,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const statusBadge = (status) => {
    const known = DOCUMENT_STATUSES[status];
    const label = known ? t(`documentStatuses.${known.key}`) : status;
    return `<span class="badge ${known ? known.badge : "badge-blue"}">${label}</span>`;
  };
  const url = `${appUrl}/documents`;

  await module.exports.sendMail({
    to,
    subject: t("documentStatusChanged.subject", { documentName }),
    html: template(locale, `
      <h2>${t("documentStatusChanged.heading")}</h2>
      <p>${t("common.greeting", { name: recipientName })}</p>
      <p>${t("documentStatusChanged.intro")}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t("labels.document")}</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.number")}</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("documentStatusChanged.previousStatus")}</span>
          <span class="info-val">${statusBadge(oldStatus)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("documentStatusChanged.newStatus")}</span>
          <span class="info-val">${statusBadge(newStatus)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("documentStatusChanged.changedBy")}</span>
          <span class="info-val">${changedByName}</span>
        </div>
      </div>
      <a href="${url}" class="btn">${t("common.openDocument")}</a>
    `),
  });
}

/**
 * A workflow task was completed (notification for the document owner).
 */
async function sendTaskCompleted({
  to,
  locale,
  ownerName,
  taskType,
  documentName,
  docNumber,
  completedByName,
  comment,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const introKey = DOCUMENT_TASK_BADGES[taskType] ? taskType : "other";
  const url = `${appUrl}/documents`;

  await module.exports.sendMail({
    to,
    subject: t("taskCompleted.subject", { documentName }),
    html: template(locale, `
      <h2>${t("taskCompleted.heading")}</h2>
      <p>${t("common.greeting", { name: ownerName })}</p>
      <p>${t(`taskCompleted.intro.${introKey}`, { completedByName, documentName })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t("labels.document")}</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.number")}</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("taskCompleted.completedBy")}</span>
          <span class="info-val">${completedByName}</span>
        </div>
        ${
          comment
            ? `<div class="info-row">
          <span class="info-label">${t("labels.comment")}</span>
          <span class="info-val">${comment}</span>
        </div>`
            : ""
        }
      </div>
      <a href="${url}" class="btn">${t("common.openDocument")}</a>
    `),
  });
}

/**
 * A workflow task was rejected (notification for the document owner).
 */
async function sendTaskRejected({
  to,
  locale,
  ownerName,
  documentName,
  docNumber,
  rejectedByName,
  comment,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const url = `${appUrl}/documents`;

  await module.exports.sendMail({
    to,
    subject: t("taskRejected.subject", { documentName }),
    html: template(locale, `
      <h2>${t("taskRejected.heading")}</h2>
      <p>${t("common.greeting", { name: ownerName })}</p>
      <p>${t("taskRejected.intro", { rejectedByName, documentName })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t("labels.document")}</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.number")}</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("taskRejected.rejectedBy")}</span>
          <span class="info-val">${rejectedByName}</span>
        </div>
        ${
          comment
            ? `<div class="info-row">
          <span class="info-label">${t("taskRejected.reason")}</span>
          <span class="info-val" style="color:#DC2626">${comment}</span>
        </div>`
            : ""
        }
      </div>
      <a href="${url}" class="btn">${t("common.openDocument")}</a>
    `),
  });
}

/**
 * A document was signed electronically (Signus).
 */
async function sendDocumentSigned({
  to,
  locale,
  recipientName,
  documentName,
  docNumber,
  signedByName,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const url = `${appUrl}/documents`;

  await module.exports.sendMail({
    to,
    subject: t("documentSigned.subject", { documentName }),
    html: template(locale, `
      <h2>${t("documentSigned.heading")}</h2>
      <p>${t("common.greeting", { name: recipientName })}</p>
      <p>${t("documentSigned.intro", { documentName })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t("labels.document")}</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.number")}</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("documentSigned.signedBy")}</span>
          <span class="info-val">${signedByName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t("labels.status")}</span>
          <span class="info-val"><span class="badge badge-green">${t("documentSigned.signedStatus")}</span></span>
        </div>
      </div>
      <a href="${url}" class="btn">${t("common.openDocument")}</a>
    `),
  });
}

/**
 * Invitation of a new user.
 */
async function sendUserInvitation({
  to,
  locale,
  displayName,
  invitedByName,
  loginUrl,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);

  await module.exports.sendMail({
    to,
    subject: t("userInvitation.subject"),
    html: template(locale, `
      <h2>${t("userInvitation.heading")}</h2>
      <p>${t("common.greeting", { name: displayName })}</p>
      <p>${t("userInvitation.intro", { invitedByName })}</p>
      <p>${t("userInvitation.loginHint", { email: to })}</p>
      <a href="${loginUrl || appUrl}" class="btn">${t("userInvitation.signIn")}</a>
      <p style="color:#71717A;font-size:12px;margin-top:16px">
        ${t("userInvitation.ignoreHint")}
      </p>
    `),
  });
}

/**
 * A CRM activity (of a lead or a partner) was assigned to the user.
 */
async function sendCrmActivityAssigned({
  to,
  locale,
  assigneeName,
  assignerName,
  activityType,
  activityTitle,
  activityAt,
  sourceName,
  sourceType,  // 'lead' | 'partner'
  sourceId,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const timeZone = await timeZoneFor(tenantId);
  const t = emailTexts(locale);
  const isPartner = sourceType === 'partner';
  const typeLabel = activityTypeLabel(t, ACTIVITY_TYPE_KEYS, activityType);
  const url = `${appUrl}/crm/${isPartner ? 'partners' : 'leads'}/${sourceId}`;

  await module.exports.sendMail({
    to,
    subject: t('crmActivityAssigned.subject', { activityTitle }),
    html: template(locale, `
      <h2>${t('crmActivityAssigned.heading')}</h2>
      <p>${t('common.greeting', { name: assigneeName })}</p>
      <p>${t('crmActivityAssigned.intro', { assignerName })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t(isPartner ? 'labels.partner' : 'labels.lead')}</span>
          <span class="info-val">${sourceName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.type')}</span>
          <span class="info-val"><span class="badge badge-orange">${typeLabel}</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.title')}</span>
          <span class="info-val">${activityTitle}</span>
        </div>
        ${activityAt ? `<div class="info-row">
          <span class="info-label">${t('labels.activityDate')}</span>
          <span class="info-val">${formatDateTime(locale, activityAt, timeZone)}</span>
        </div>` : ''}
        <div class="info-row">
          <span class="info-label">${t('labels.assigner')}</span>
          <span class="info-val">${assignerName}</span>
        </div>
      </div>
      <a href="${url}" class="btn">${t(isPartner ? 'common.openPartner' : 'common.openLead')}</a>
      <p style="color:#71717A;font-size:12px;margin-top:12px">
        ${t('crmActivityAssigned.calendarHint')}
      </p>
    `),
  });
}

/**
 * The user became the owner of a lead or a partner.
 */
async function sendCrmOwnerAssigned({
  to,
  locale,
  ownerName,
  assignerName,
  sourceName,
  sourceType,  // 'lead' | 'partner'
  sourceId,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const isPartner = sourceType === 'partner';
  const variant = isPartner ? 'Partner' : 'Lead';
  const url = `${appUrl}/crm/${isPartner ? 'partners' : 'leads'}/${sourceId}`;

  await module.exports.sendMail({
    to,
    subject: t(`crmOwnerAssigned.subject${variant}`, { sourceName }),
    html: template(locale, `
      <h2>${t(`crmOwnerAssigned.heading${variant}`)}</h2>
      <p>${t('common.greeting', { name: escapeHtml(ownerName) })}</p>
      <p>${t(`crmOwnerAssigned.intro${variant}`, { assignerName: escapeHtml(assignerName) })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t(isPartner ? 'labels.partner' : 'labels.lead')}</span>
          <span class="info-val">${escapeHtml(sourceName)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.assigner')}</span>
          <span class="info-val">${escapeHtml(assignerName)}</span>
        </div>
      </div>
      <a href="${url}" class="btn">${t(isPartner ? 'common.openPartner' : 'common.openLead')}</a>
    `),
  });
}

/**
 * Reminder about an upcoming CRM activity (of a lead or a partner),
 * sent by crmReminderService.js.
 */
async function sendActivityReminder({
  to,
  locale,
  recipientName,
  activityType,
  activityTitle,
  activityAt,
  reminderType,   // 'at_due' | '1d_before' | '2d_before' | '3d_before' | 'custom'
  sourceType,     // 'lead' | 'partner'
  sourceId,
  sourceName,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const timeZone = await timeZoneFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);
  const isPartner = sourceType === 'partner';
  const url = `${appUrl}/crm/${isPartner ? 'partners' : 'leads'}/${sourceId}`;
  const typeLabel = activityTypeLabel(t, REMINDER_ACTIVITY_TYPE_KEYS, activityType);
  const reminder = reminderLabel(t, reminderType, 'activityAtDue');

  await module.exports.sendMail({
    to,
    subject: t('activityReminder.subject', { activityType: typeLabel, activityTitle }),
    html: template(locale, `
      <h2>${t('activityReminder.heading')}</h2>
      <p>${t('common.greeting', { name: recipientName || '' })}</p>
      <p>${t('activityReminder.intro')}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t(isPartner ? 'labels.partner' : 'labels.lead')}</span>
          <span class="info-val">${sourceName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.type')}</span>
          <span class="info-val"><span class="badge badge-orange">${typeLabel}</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.task')}</span>
          <span class="info-val"><strong>${activityTitle}</strong></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.activityDate')}</span>
          <span class="info-val">${activityAt ? formatDateTime(locale, activityAt, timeZone) : '—'}</span>
        </div>
        ${reminder ? `<div class="info-row">
          <span class="info-label">${t('labels.reminder')}</span>
          <span class="info-val">${reminder}</span>
        </div>` : ''}
      </div>
      <a href="${url}" target="_blank" class="btn">${t(isPartner ? 'common.openPartner' : 'common.openLead')}</a>
      <p style="color:#71717A;font-size:12px;margin-top:12px">
        ${t('activityReminder.linkHint')}
      </p>
    `),
  });
}

/**
 * Informational notification: you have been named as a substitute for an absence.
 * No acceptance step — pure information.
 */
async function sendSubstitutionAssigned({
  to,
  locale,
  substituteName,
  absentName,
  assignerName,
  startsOn,
  endsOn,
  reason,   // 'vacation' | 'sick_leave' | 'other'
  note,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);
  const reasonLabel = t(`absenceReasons.${ABSENCE_REASON_KEYS[reason] || 'other'}`);
  const formatDay = (day) => (day ? formatDate(locale, day) : '—');
  const url = `${appUrl}/crm/leads`;

  await module.exports.sendMail({
    to,
    subject: t('substitutionAssigned.subject', { absentName, startsOn: formatDay(startsOn), endsOn: formatDay(endsOn) }),
    html: template(locale, `
      <h2>${t('substitutionAssigned.heading')}</h2>
      <p>${t('common.greeting', { name: substituteName })}</p>
      <p>${t('substitutionAssigned.intro', { assignerName, absentName })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t('substitutionAssigned.absentPerson')}</span>
          <span class="info-val">${absentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('substitutionAssigned.reason')}</span>
          <span class="info-val"><span class="badge badge-orange">${reasonLabel}</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('substitutionAssigned.from')}</span>
          <span class="info-val">${formatDay(startsOn)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('substitutionAssigned.toInclusive')}</span>
          <span class="info-val">${formatDay(endsOn)}</span>
        </div>
        ${note ? `<div class="info-row">
          <span class="info-label">${t('substitutionAssigned.note')}</span>
          <span class="info-val">${htmlText(note)}</span>
        </div>` : ''}
      </div>
      <a href="${url}" class="btn">${t('substitutionAssigned.openCrm')}</a>
      <p style="color:#71717A;font-size:12px;margin-top:12px">
        ${t('substitutionAssigned.infoOnly')}
      </p>
    `),
  });
}

async function sendProjectTaskAssigned({
  to,
  locale,
  assigneeName,
  assignerName,
  projectId,
  projectName,
  taskId,
  taskLabel,   // e.g. "WSC-12"
  taskName,
  endDate,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  const t = emailTexts(locale);
  const url = `${appUrl}/projects/${projectId}?task=${taskId}`;

  await module.exports.sendMail({
    to,
    subject: t('projectTaskAssigned.subject', { taskLabel, taskName }),
    html: template(locale, `
      <h2>${t('projectTaskAssigned.heading')}</h2>
      <p>${t('common.greeting', { name: escapeHtml(assigneeName) })}</p>
      <p>${t('projectTaskAssigned.intro', { assignerName: escapeHtml(assignerName) })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t('labels.project')}</span>
          <span class="info-val">${escapeHtml(projectName)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.task')}</span>
          <span class="info-val">${escapeHtml(taskLabel)} ${escapeHtml(taskName)}</span>
        </div>
        ${endDate ? `<div class="info-row">
          <span class="info-label">${t('labels.dueDate')}</span>
          <span class="info-val">${escapeHtml(endDate)}</span>
        </div>` : ''}
      </div>
      <a href="${url}" class="btn">${t('common.openTask')}</a>
    `),
  });
}

async function sendProjectTaskReminder({
  to,
  locale,
  recipientName,
  projectId,
  projectName,
  taskId,
  taskLabel,   // e.g. "WSC-12"
  taskName,
  endDate,
  reminderType,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);
  const url = `${appUrl}/projects/${projectId}?task=${taskId}`;
  const reminder = reminderLabel(t, reminderType, 'projectAtDue');

  await module.exports.sendMail({
    to,
    subject: t('projectTaskReminder.subject', { taskLabel, taskName }),
    html: template(locale, `
      <h2>${t('projectTaskReminder.heading')}</h2>
      <p>${t('common.greeting', { name: escapeHtml(recipientName || '') })}</p>
      <p>${t('projectTaskReminder.intro')}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t('labels.project')}</span>
          <span class="info-val">${escapeHtml(projectName)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.task')}</span>
          <span class="info-val"><strong>${escapeHtml(taskLabel)} ${escapeHtml(taskName)}</strong></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.dueDate')}</span>
          <span class="info-val">${escapeHtml(endDate || '—')}</span>
        </div>
        ${reminder ? `<div class="info-row">
          <span class="info-label">${t('labels.reminder')}</span>
          <span class="info-val">${reminder}</span>
        </div>` : ''}
      </div>
      <a href="${url}" target="_blank" class="btn">${t('common.openTask')}</a>
    `),
  });
}

// ─── Project deadline mails (sent by projectDeadlineNotificationService) ─────

const projectTaskUrl = (appUrl, projectId, taskId) => `${appUrl}/projects/${projectId}?task=${taskId}`;
const projectUrl = (appUrl, projectId) => `${appUrl}/projects/${projectId}`;

/**
 * Somebody other than the receiving PM changed the end date of a task.
 */
async function sendProjectTaskEndDateChanged({
  to,
  locale,
  recipientName,
  changedByName,
  projectId,
  projectName,
  taskId,
  taskLabel,        // e.g. "WSC-12"
  taskName,
  previousEndDate,  // "YYYY-MM-DD" or null
  newEndDate,       // "YYYY-MM-DD" or null
  originalEndDate,  // "YYYY-MM-DD" or null
  slipDays,         // new end date − original, in days; null when equal or unknown
  reason,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);
  const formatDay = (day) => (day ? formatDateOnly(locale, day) : t('projectEndDateChanged.noDate'));
  const slip = slipDays
    ? t(slipDays > 0 ? 'projectEndDateChanged.slipLater' : 'projectEndDateChanged.slipEarlier', { count: Math.abs(slipDays) })
    : '';

  await module.exports.sendMail({
    to,
    subject: t('projectEndDateChanged.subject', { taskLabel, taskName }),
    html: template(locale, `
      <h2>${t('projectEndDateChanged.heading')}</h2>
      <p>${t('common.greeting', { name: escapeHtml(recipientName || '') })}</p>
      <p>${t('projectEndDateChanged.intro', { changedByName: escapeHtml(changedByName) })}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t('labels.project')}</span>
          <span class="info-val">${escapeHtml(projectName)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('labels.task')}</span>
          <span class="info-val"><strong>${escapeHtml(taskLabel)} ${escapeHtml(taskName)}</strong></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('projectEndDateChanged.dueDateChange')}</span>
          <span class="info-val">${formatDay(previousEndDate)} → ${formatDay(newEndDate)}</span>
        </div>
        ${originalEndDate ? `<div class="info-row">
          <span class="info-label">${t('projectEndDateChanged.originalDueDate')}</span>
          <span class="info-val">${formatDay(originalEndDate)}${slip ? ` (${slip})` : ''}</span>
        </div>` : ''}
        ${reason ? `<div class="info-row">
          <span class="info-label">${t('projectEndDateChanged.reason')}</span>
          <span class="info-val">${htmlText(reason)}</span>
        </div>` : ''}
      </div>
      <a href="${projectTaskUrl(appUrl, projectId, taskId)}" class="btn">${t('common.openTask')}</a>
    `),
  });
}

/**
 * A change made the project delayed: a not-done task now ends after the project's end date.
 */
async function sendProjectDelayed({
  to,
  locale,
  recipientName,
  projectId,
  projectName,
  projectEndDate,
  tasksAfterEndCount,
  latestTaskEndDate,
  daysAfterEnd,
  tenantId,
}) {
  const appUrl = await appUrlFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);

  await module.exports.sendMail({
    to,
    subject: t('projectDelayed.subject', { projectName }),
    html: template(locale, `
      <h2>${t('projectDelayed.heading')}</h2>
      <p>${t('common.greeting', { name: escapeHtml(recipientName || '') })}</p>
      <p>${t('projectDelayed.intro')}</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">${t('labels.project')}</span>
          <span class="info-val"><strong>${escapeHtml(projectName)}</strong></span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('projectDelayed.projectEndDate')}</span>
          <span class="info-val">${formatDateOnly(locale, projectEndDate)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('projectDelayed.tasksAfterEnd')}</span>
          <span class="info-val">${tasksAfterEndCount}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${t('projectDelayed.latestTaskDueDate')}</span>
          <span class="info-val">${formatDateOnly(locale, latestTaskEndDate)} (${t('projectDelayed.daysAfterEnd', { count: daysAfterEnd })})</span>
        </div>
      </div>
      <a href="${projectUrl(appUrl, projectId)}" class="btn">${t('projectDelayed.openProject')}</a>
    `),
  });
}

function deadlineSummaryTaskRow(t, locale, task, { showAssignees, appUrl }) {
  const details = [
    t('projectDeadlineSummary.dueOn', { date: formatDateOnly(locale, task.end_date) }),
    t('projectDeadlineSummary.daysOverdue', { count: task.days_overdue }),
  ];
  if (showAssignees) {
    details.push(task.assignees.length
      ? t('projectDeadlineSummary.assignees', {
        names: escapeHtml(task.assignees.map((assignee) => assignee.display_name).join(', ')),
      })
      : t('projectDeadlineSummary.unassigned'));
  }
  const label = `${task.project.key}-${task.task_number}`;
  return `<div style="padding:6px 0;border-bottom:1px solid #E4E4E7">
    <a href="${projectTaskUrl(appUrl, task.project.id, task.id)}" style="color:#18181B;font-weight:600;text-decoration:none">${escapeHtml(label)} ${escapeHtml(task.name)}</a>
    ${task.is_new ? `<span class="badge badge-red">${t('projectDeadlineSummary.newBadge')}</span>` : ''}
    <div style="color:#71717A;font-size:12px">${details.join(' · ')}</div>
  </div>`;
}

function deadlineSummaryDelayReasons(t, locale, { project, delay }) {
  const { delay_details: details } = delay;
  const reasons = [];
  if (delay.delay_reasons.includes('task_after_end')) {
    reasons.push(t('projectDeadlineSummary.reasonTaskAfterEnd', {
      count: details.tasks_after_end_count,
      latestDate: formatDateOnly(locale, details.latest_task_end_date),
      days: details.days_after_end,
    }));
  }
  if (delay.delay_reasons.includes('end_passed')) {
    const reason = t('projectDeadlineSummary.reasonEndPassed', {
      date: formatDateOnly(locale, project.end_date),
      days: details.days_past_end,
      count: details.open_task_count,
    });
    // The end date passed today exactly when it was yesterday.
    const isNew = details.days_past_end === 1;
    reasons.push(isNew ? `${reason} <span class="badge badge-red">${t('projectDeadlineSummary.newBadge')}</span>` : reason);
  }
  return reasons;
}

/**
 * Daily summary of overdue tasks and delayed projects, one mail per person:
 * `ownTasks` — overdue tasks assigned to the recipient; `managedProjects` —
 * for a PM, the projects they run that have overdue tasks or are delayed.
 * Either part may be empty; tasks arrive with the ones that became overdue
 * today first.
 */
async function sendProjectDeadlineSummary({ to, locale, recipientName, date, ownTasks, managedProjects, tenantId }) {
  const appUrl = await appUrlFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);
  const formattedDate = formatDateOnly(locale, date);
  const sectionHeading = (text) => `<h3 style="margin:20px 0 6px;font-size:15px;color:#18181B">${text}</h3>`;
  const projectHeading = (project) => `<p style="margin:12px 0 2px"><a href="${projectUrl(appUrl, project.id)}" style="color:#2F8F4D;font-weight:600;text-decoration:none">${escapeHtml(project.name)}</a></p>`;

  const projectsWithOverdueTasks = managedProjects.filter((report) => report.overdueTasks.length);
  const delayedProjects = managedProjects.filter((report) => report.delay);

  const ownSection = ownTasks.length ? `
      ${sectionHeading(t('projectDeadlineSummary.ownTasksHeading'))}
      ${ownTasks.map((task) => deadlineSummaryTaskRow(t, locale, task, { showAssignees: false, appUrl })).join('')}` : '';
  const managedSection = projectsWithOverdueTasks.length ? `
      ${sectionHeading(t('projectDeadlineSummary.managedTasksHeading'))}
      ${projectsWithOverdueTasks.map(({ project, overdueTasks }) => `
        ${projectHeading(project)}
        ${overdueTasks.map((task) => deadlineSummaryTaskRow(t, locale, { ...task, project }, { showAssignees: true, appUrl })).join('')}`).join('')}` : '';
  const delayedSection = delayedProjects.length ? `
      ${sectionHeading(t('projectDeadlineSummary.delayedProjectsHeading'))}
      ${delayedProjects.map((report) => `
        ${projectHeading(report.project)}
        ${deadlineSummaryDelayReasons(t, locale, report).map((reason) => `<div style="color:#71717A;font-size:12px;padding:2px 0">${reason}</div>`).join('')}`).join('')}` : '';

  await module.exports.sendMail({
    to,
    subject: t('projectDeadlineSummary.subject', { date: formattedDate }),
    html: template(locale, `
      <h2>${t('projectDeadlineSummary.heading')}</h2>
      <p>${t('common.greeting', { name: escapeHtml(recipientName || '') })}</p>
      <p>${t('projectDeadlineSummary.intro', { date: formattedDate })}</p>
      ${ownSection}${managedSection}${delayedSection}
      <p style="color:#71717A;font-size:12px;margin-top:20px">
        ${t('projectDeadlineSummary.settingsHint')}
      </p>
    `),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dzienny raport zadań („digest")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jeden zbiorczy mail z zadaniami wymagającymi uwagi. Sekcje puste nie są
 * rysowane, a całkiem pusty raport w ogóle nie trafia do tej funkcji — pilnuje
 * tego dailyDigestService (zasada z worktrips: pusta lista = brak maila).
 */
async function sendDailyDigest({ to, locale, recipientName, digest, date, tenantId }) {
  const appUrl = await appUrlFor(tenantId);
  if (!to) return;

  const t = emailTexts(locale);
  const { overdue, unread, today, noDate } = digest;

  const SOURCE_ICON = {
    lead: '🎯', partner: '🤝', onboarding: '🚀', workflow: '📄', project: '📋',
  };

  // Adres rekordu. Zadanie projektowe trafia wprost w panel zadania (?task=),
  // bo na ten sam adres prowadzą linki z pozostałych maili o zadaniach.
  const itemUrl = (item) => {
    if (item.source === 'lead')       return `${appUrl}/crm/leads/${item.source_id}`;
    if (item.source === 'partner')    return `${appUrl}/crm/partners/${item.source_id}`;
    if (item.source === 'onboarding') return `${appUrl}/crm/onboarding`;
    if (item.source === 'workflow')   return `${appUrl}/documents`;
    if (item.source === 'project')    return `${appUrl}/projects/${item.source_id}?task=${item.task_id}`;
    return appUrl;
  };

  // Typy biorą się z istniejących słowników, a nie z nowych kluczy pod
  // `digest.*`: obieg dokumentów ma własne nazwy zadań (do akceptacji, do
  // podpisania), a pozostałe źródła używają typów aktywności CRM. Dublowanie
  // ich w dziesięciu językach byłoby drugim miejscem do rozjechania.
  // translate() przy braku klucza zwraca SAM KLUCZ, więc typ spoza słownika
  // pokazujemy w surowej postaci z bazy.
  const TYPE_ALIAS = { doc_sent: 'docSent' };
  const typeLabel = (item) => {
    const raw = item.type || '';
    if (!raw) return '';
    const scope = item.source === 'workflow' ? 'documentTaskTypes' : 'activityTypes';
    const key = `${scope}.${TYPE_ALIAS[raw] || raw}`;
    const label = t(key);
    return label === key || label === `emails.${key}` ? raw : label;
  };
  const stepLabel = (item) => (item.step === null || item.step === undefined)
    ? '' : t(`digest.onboardingSteps.${item.step}`);

  const renderRow = (item) => `
    <tr>
      <td style="padding:7px 6px;border-bottom:1px solid #F4F4F5;font-size:12px;color:#18181B;vertical-align:top">
        ${SOURCE_ICON[item.source] || '•'}&nbsp;<strong>${escapeHtml(item.source_name || '—')}</strong>
        ${item.source === 'onboarding' ? `&nbsp;<span style="font-size:10px;background:#E6F4EA;color:#2F8F4D;border-radius:4px;padding:1px 5px">${escapeHtml(stepLabel(item))}</span>` : ''}
      </td>
      <td style="padding:7px 6px;border-bottom:1px solid #F4F4F5;font-size:12px;color:#374151;vertical-align:top">
        ${escapeHtml(item.title || '—')}
      </td>
      <td style="padding:7px 6px;border-bottom:1px solid #F4F4F5;font-size:11px;color:#71717A;white-space:nowrap;vertical-align:top">
        ${escapeHtml(typeLabel(item))}
        ${item.due_date ? `<br><span style="color:#BE123C">${formatDateOnly(locale, item.due_date)}</span>` : ''}
      </td>
      <td style="padding:7px 6px;border-bottom:1px solid #F4F4F5;text-align:right;vertical-align:top">
        <a href="${itemUrl(item)}" style="color:var(--orange,#3BAA5D);color:#3BAA5D;font-size:11px;font-weight:600;text-decoration:none">${t('digest.open')}&nbsp;→</a>
      </td>
    </tr>`;

  const renderSection = (icon, title, badgeBg, items) => items.length ? `
      <h3 style="font-size:13px;font-weight:700;color:#18181B;margin:22px 0 6px">
        ${icon}&nbsp;${title}&nbsp;<span style="background:${badgeBg};color:white;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600">${items.length}</span>
      </h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:4px">
        <colgroup><col style="width:30%"><col style="width:40%"><col style="width:18%"><col style="width:12%"></colgroup>
        <tbody>${items.map(renderRow).join('')}</tbody>
      </table>` : '';

  const dateLabel = formatDateOnly(locale, date);

  await module.exports.sendMail({
    to,
    subject: t('digest.subject', { date: dateLabel }),
    html: template(locale, `
      <h2>${t('digest.heading', { date: dateLabel })}</h2>
      <p>${t('common.greeting', { name: recipientName || '' })}</p>
      <p style="font-size:12px;color:#71717A;margin:0 0 8px">${t('digest.intro')}</p>

      ${renderSection('❌', t('digest.sections.overdue'), '#BE123C', overdue)}
      ${renderSection('📧', t('digest.sections.unread'), '#1D4ED8', unread)}
      ${renderSection('📅', t('digest.sections.today'), '#D97706', today)}
      ${renderSection('📋', t('digest.sections.noDate'), '#71717A', noDate)}

      <div style="margin-top:20px">
        <a href="${appUrl}/crm/dashboard" class="btn">${t('digest.cta')}</a>
      </div>
      <p style="font-size:11px;color:#A1A1AA;margin-top:14px">
        ${t('digest.optOut')} <a href="${appUrl}/my-settings" style="color:#3BAA5D">${t('digest.optOutLink')}</a>.
      </p>
    `),
  });
}

module.exports = {
  sendDailyDigest,
  sendProjectTaskEndDateChanged,
  sendProjectDelayed,
  sendProjectDeadlineSummary,
  sendProjectTaskReminder,
  sendProjectTaskAssigned,
  sendMail,
  sendTaskAssigned,
  sendDocumentStatusChanged,
  sendTaskCompleted,
  sendTaskRejected,
  sendDocumentSigned,
  sendUserInvitation,
  sendCrmActivityAssigned,
  sendCrmOwnerAssigned,
  sendActivityReminder,
  sendSubstitutionAssigned,
};
