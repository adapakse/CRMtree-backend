"use strict";

/**
 * email.js — Gmail API via Service Account + Domain-Wide Delegation
 *
 * Wysyła maile z noreply@worktrips.com używając konta serwisowego Google.
 * Nie wymaga haseł ani OAuth per użytkownik.
 */

const { google } = require("googleapis");
const path = require("path");
const config = require("../config");
const logger = require("./logger");
const { translate, formatDate, formatDateOnly, formatDateTime, supportedOrDefault } = require("./i18n");

// ─── Inicjalizacja klienta Gmail ─────────────────────────────────────────────

let _gmailClient = null;

async function getGmailClient() {
  if (_gmailClient) return _gmailClient;

  // Klucz serwisowy: plik JSON lub JSON ze zmiennej środowiskowej
  let credentials;
  if (config.google.serviceAccountJson) {
    credentials = JSON.parse(config.google.serviceAccountJson);
  } else if (config.google.serviceAccountFile) {
    credentials = require(path.resolve(config.google.serviceAccountFile));
  } else {
    throw new Error(
      "Brak konfiguracji Google Service Account (GOOGLE_SERVICE_ACCOUNT_JSON lub GOOGLE_SERVICE_ACCOUNT_FILE)",
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
  });

  // Impersonacja — wysyłamy jako noreply@worktrips.com
  const authClient = await auth.getClient();
  authClient.subject = config.google.impersonateEmail;

  _gmailClient = google.gmail({ version: "v1", auth: authClient });
  return _gmailClient;
}

// ─── Helpers RFC 2047 / RFC 2045 ─────────────────────────────────────────────

// RFC 2047: enkoduje display name gdy zawiera znaki spoza ASCII
function encodeRfc2047(str) {
  if (!str || !/[^\x00-\x7F]/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

// RFC 2045: base64 body musi być zawijane co max 76 znaków
function wrapBase64(b64) {
  return b64.match(/.{1,76}/g).join("\r\n");
}

// ─── Budowanie wiadomości RFC 2822 ───────────────────────────────────────────

function buildRawMessage({ to, subject, html, text }) {
  const fromName = encodeRfc2047(config.email.fromName);
  const from = fromName
    ? `${fromName} <${config.email.from}>`
    : config.email.from;
  const boundary = `boundary_${Date.now()}`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
  ].join("\r\n");

  const textPart = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(text || stripHtml(html), "utf8").toString("base64")),
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(html, "utf8").toString("base64")),
  ].join("\r\n");

  const raw = `${headers}\r\n${textPart}\r\n\r\n${htmlPart}\r\n\r\n--${boundary}--`;
  return Buffer.from(raw).toString("base64url");
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
  if (config.isDev && !config.google.sendInDev) {
    logger.info(
      `[DEV] Email NIE wysłany (ustaw GOOGLE_SEND_IN_DEV=true aby wysyłać w dev)`,
      {
        to,
        subject,
      },
    );
    return;
  }

  try {
    const gmail = await getGmailClient();
    const raw = buildRawMessage({ to, subject, html, text });

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
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
}) {
  const t = emailTexts(locale);
  const taskBadge = DOCUMENT_TASK_BADGES[taskType] || "badge-blue";
  const taskTypeLabel = DOCUMENT_TASK_BADGES[taskType] ? t(`documentTaskTypes.${taskType}`) : taskType;
  const url = `${BASE_URL}/documents`;

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
}) {
  const t = emailTexts(locale);
  const statusBadge = (status) => {
    const known = DOCUMENT_STATUSES[status];
    const label = known ? t(`documentStatuses.${known.key}`) : status;
    return `<span class="badge ${known ? known.badge : "badge-blue"}">${label}</span>`;
  };
  const url = `${BASE_URL}/documents`;

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
}) {
  const t = emailTexts(locale);
  const introKey = DOCUMENT_TASK_BADGES[taskType] ? taskType : "other";
  const url = `${BASE_URL}/documents`;

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
}) {
  const t = emailTexts(locale);
  const url = `${BASE_URL}/documents`;

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
}) {
  const t = emailTexts(locale);
  const url = `${BASE_URL}/documents`;

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
}) {
  const t = emailTexts(locale);

  await module.exports.sendMail({
    to,
    subject: t("userInvitation.subject"),
    html: template(locale, `
      <h2>${t("userInvitation.heading")}</h2>
      <p>${t("common.greeting", { name: displayName })}</p>
      <p>${t("userInvitation.intro", { invitedByName })}</p>
      <p>${t("userInvitation.loginHint", { email: to })}</p>
      <a href="${loginUrl || BASE_URL}" class="btn">${t("userInvitation.signIn")}</a>
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
}) {
  const t = emailTexts(locale);
  const isPartner = sourceType === 'partner';
  const typeLabel = activityTypeLabel(t, ACTIVITY_TYPE_KEYS, activityType);
  const url = `${BASE_URL}/crm/${isPartner ? 'partners' : 'leads'}/${sourceId}`;

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
          <span class="info-val">${formatDateTime(locale, activityAt)}</span>
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
}) {
  const t = emailTexts(locale);
  const isPartner = sourceType === 'partner';
  const variant = isPartner ? 'Partner' : 'Lead';
  const url = `${BASE_URL}/crm/${isPartner ? 'partners' : 'leads'}/${sourceId}`;

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
}) {
  if (!to) return;

  const t = emailTexts(locale);
  const isPartner = sourceType === 'partner';
  const url = `${BASE_URL}/crm/${isPartner ? 'partners' : 'leads'}/${sourceId}`;
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
          <span class="info-val">${activityAt ? formatDateTime(locale, activityAt) : '—'}</span>
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
}) {
  if (!to) return;

  const t = emailTexts(locale);
  const reasonLabel = t(`absenceReasons.${ABSENCE_REASON_KEYS[reason] || 'other'}`);
  const formatDay = (day) => (day ? formatDate(locale, day) : '—');
  const url = `${BASE_URL}/crm/leads`;

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
}) {
  const t = emailTexts(locale);
  const url = `${BASE_URL}/projects/${projectId}?task=${taskId}`;

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
}) {
  if (!to) return;

  const t = emailTexts(locale);
  const url = `${BASE_URL}/projects/${projectId}?task=${taskId}`;
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

const projectTaskUrl = (projectId, taskId) => `${BASE_URL}/projects/${projectId}?task=${taskId}`;
const projectUrl = (projectId) => `${BASE_URL}/projects/${projectId}`;

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
}) {
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
      <a href="${projectTaskUrl(projectId, taskId)}" class="btn">${t('common.openTask')}</a>
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
}) {
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
      <a href="${projectUrl(projectId)}" class="btn">${t('projectDelayed.openProject')}</a>
    `),
  });
}

function deadlineSummaryTaskRow(t, locale, task, { showAssignees }) {
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
    <a href="${projectTaskUrl(task.project.id, task.id)}" style="color:#18181B;font-weight:600;text-decoration:none">${escapeHtml(label)} ${escapeHtml(task.name)}</a>
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
async function sendProjectDeadlineSummary({ to, locale, recipientName, date, ownTasks, managedProjects }) {
  if (!to) return;

  const t = emailTexts(locale);
  const formattedDate = formatDateOnly(locale, date);
  const sectionHeading = (text) => `<h3 style="margin:20px 0 6px;font-size:15px;color:#18181B">${text}</h3>`;
  const projectHeading = (project) => `<p style="margin:12px 0 2px"><a href="${projectUrl(project.id)}" style="color:#2F8F4D;font-weight:600;text-decoration:none">${escapeHtml(project.name)}</a></p>`;

  const projectsWithOverdueTasks = managedProjects.filter((report) => report.overdueTasks.length);
  const delayedProjects = managedProjects.filter((report) => report.delay);

  const ownSection = ownTasks.length ? `
      ${sectionHeading(t('projectDeadlineSummary.ownTasksHeading'))}
      ${ownTasks.map((task) => deadlineSummaryTaskRow(t, locale, task, { showAssignees: false })).join('')}` : '';
  const managedSection = projectsWithOverdueTasks.length ? `
      ${sectionHeading(t('projectDeadlineSummary.managedTasksHeading'))}
      ${projectsWithOverdueTasks.map(({ project, overdueTasks }) => `
        ${projectHeading(project)}
        ${overdueTasks.map((task) => deadlineSummaryTaskRow(t, locale, { ...task, project }, { showAssignees: true })).join('')}`).join('')}` : '';
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

module.exports = {
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
