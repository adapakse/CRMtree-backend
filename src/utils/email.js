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

// ─── Budowanie wiadomości RFC 2822 ───────────────────────────────────────────

function buildRawMessage({ to, subject, html, text }) {
  const from = `${config.email.fromName} <${config.email.from}>`;
  const boundary = `boundary_${Date.now()}`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
  ].join("\r\n");

  const textPart = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text || stripHtml(html)).toString("base64"),
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
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

// ─── Szablony wiadomości ──────────────────────────────────────────────────────

const BASE_URL = config.frontendUrl;

/**
 * Bazowy wrapper HTML z brandingiem worktrips.doc
 */
function template(content) {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin:0; padding:0; background:#F4F4F5; font-family:'Segoe UI',Arial,sans-serif; }
    .wrap { max-width:560px; margin:32px auto; background:white; border-radius:12px;
            border:1px solid #E4E4E7; overflow:hidden; }
    .header { background:#18181B; padding:20px 28px; display:flex; align-items:center; }
    .logo { font-size:17px; font-weight:700; color:white; letter-spacing:-.3px; }
    .logo span { color:#F26522; }
    .body { padding:28px 28px 20px; color:#27272A; font-size:14px; line-height:1.6; }
    .body h2 { margin:0 0 12px; font-size:18px; color:#18181B; }
    .info-box { background:#FAFAFA; border:1px solid #E4E4E7; border-radius:8px;
                padding:14px 16px; margin:16px 0; font-size:13px; }
    .info-row { display:flex; gap:8px; padding:4px 0; }
    .info-label { color:#71717A; min-width:110px; }
    .info-val { color:#18181B; font-weight:500; }
    .btn { display:inline-block; background:#F26522; color:white; text-decoration:none;
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
      <span class="logo">worktrips<span>.doc</span></span>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      Ta wiadomość została wygenerowana automatycznie przez system worktrips.doc.<br>
      Nie odpowiadaj na tego maila — adres noreply@worktrips.com nie jest monitorowany.
    </div>
  </div>
</body>
</html>`;
}

// ─── Gotowe szablony zdarzeń ──────────────────────────────────────────────────

/**
 * Zadanie workflow przypisane do użytkownika
 */
async function sendTaskAssigned({
  to,
  assigneeName,
  taskType,
  documentName,
  docNumber,
  assignerName,
  dueDate,
  documentId,
}) {
  const taskLabels = {
    read: { label: "Do przeczytania", badge: "badge-blue" },
    edit: { label: "Do edycji", badge: "badge-orange" },
    approve: { label: "Do akceptacji", badge: "badge-purple" },
    sign: { label: "Do podpisania", badge: "badge-purple" },
  };
  const task = taskLabels[taskType] || { label: taskType, badge: "badge-blue" };
  const url = `${BASE_URL}/documents`;

  await sendMail({
    to,
    subject: `[worktrips.doc] Nowe zadanie: ${documentName}`,
    html: template(`
      <h2>Masz nowe zadanie do wykonania</h2>
      <p>Cześć ${assigneeName},</p>
      <p>Użytkownik <strong>${assignerName}</strong> przypisał Ci zadanie dotyczące dokumentu:</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">Dokument</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Numer</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Typ zadania</span>
          <span class="info-val"><span class="badge ${task.badge}">${task.label}</span></span>
        </div>
        ${
          dueDate
            ? `<div class="info-row">
          <span class="info-label">Termin</span>
          <span class="info-val">${new Date(dueDate).toLocaleDateString("pl-PL")}</span>
        </div>`
            : ""
        }
        <div class="info-row">
          <span class="info-label">Zlecający</span>
          <span class="info-val">${assignerName}</span>
        </div>
      </div>
      <a href="${url}" class="btn">Otwórz dokument →</a>
    `),
  });
}

/**
 * Zmiana statusu dokumentu
 */
async function sendDocumentStatusChanged({
  to,
  recipientName,
  documentName,
  docNumber,
  oldStatus,
  newStatus,
  changedByName,
  documentId,
}) {
  const statusLabels = {
    new: { label: "Nowy", badge: "badge-blue" },
    being_edited: { label: "W edycji", badge: "badge-orange" },
    being_signed: { label: "Do podpisania", badge: "badge-purple" },
    being_approved: { label: "Do akceptacji", badge: "badge-purple" },
    signed: { label: "Podpisany", badge: "badge-green" },
    completed: { label: "Zakończony", badge: "badge-green" },
    hold: { label: "Wstrzymany", badge: "badge-orange" },
    rejected: { label: "Odrzucony", badge: "badge-red" },
  };
  const nStatus = statusLabels[newStatus] || {
    label: newStatus,
    badge: "badge-blue",
  };
  const oStatus = statusLabels[oldStatus] || {
    label: oldStatus,
    badge: "badge-blue",
  };
  const url = `${BASE_URL}/documents`;

  await sendMail({
    to,
    subject: `[worktrips.doc] Status dokumentu zmieniony: ${documentName}`,
    html: template(`
      <h2>Status dokumentu został zmieniony</h2>
      <p>Cześć ${recipientName},</p>
      <p>Dokument, do którego masz dostęp, zmienił status:</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">Dokument</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Numer</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Poprzedni status</span>
          <span class="info-val"><span class="badge ${oStatus.badge}">${oStatus.label}</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">Nowy status</span>
          <span class="info-val"><span class="badge ${nStatus.badge}">${nStatus.label}</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">Zmienił</span>
          <span class="info-val">${changedByName}</span>
        </div>
      </div>
      <a href="${url}" class="btn">Otwórz dokument →</a>
    `),
  });
}

/**
 * Zadanie workflow ukończone (powiadomienie dla właściciela dokumentu)
 */
async function sendTaskCompleted({
  to,
  ownerName,
  taskType,
  documentName,
  docNumber,
  completedByName,
  comment,
}) {
  const taskLabels = {
    read: "przeczytał",
    edit: "edytował",
    approve: "zaakceptował",
    sign: "podpisał",
  };
  const action = taskLabels[taskType] || "wykonał zadanie dla";
  const url = `${BASE_URL}/documents`;

  await sendMail({
    to,
    subject: `[worktrips.doc] Zadanie ukończone: ${documentName}`,
    html: template(`
      <h2>Zadanie zostało ukończone</h2>
      <p>Cześć ${ownerName},</p>
      <p>Użytkownik <strong>${completedByName}</strong> ${action} dokument <strong>${documentName}</strong>.</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">Dokument</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Numer</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Wykonał</span>
          <span class="info-val">${completedByName}</span>
        </div>
        ${
          comment
            ? `<div class="info-row">
          <span class="info-label">Komentarz</span>
          <span class="info-val">${comment}</span>
        </div>`
            : ""
        }
      </div>
      <a href="${url}" class="btn">Otwórz dokument →</a>
    `),
  });
}

/**
 * Dokument odrzucony w workflow
 */
async function sendTaskRejected({
  to,
  ownerName,
  documentName,
  docNumber,
  rejectedByName,
  comment,
}) {
  const url = `${BASE_URL}/documents`;

  await sendMail({
    to,
    subject: `[worktrips.doc] Zadanie odrzucone: ${documentName}`,
    html: template(`
      <h2>Zadanie zostało odrzucone</h2>
      <p>Cześć ${ownerName},</p>
      <p>Użytkownik <strong>${rejectedByName}</strong> odrzucił zadanie dla dokumentu <strong>${documentName}</strong>.</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">Dokument</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Numer</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Odrzucił</span>
          <span class="info-val">${rejectedByName}</span>
        </div>
        ${
          comment
            ? `<div class="info-row">
          <span class="info-label">Powód</span>
          <span class="info-val" style="color:#DC2626">${comment}</span>
        </div>`
            : ""
        }
      </div>
      <a href="${url}" class="btn">Otwórz dokument →</a>
    `),
  });
}

/**
 * Dokument podpisany przez Signus
 */
async function sendDocumentSigned({
  to,
  recipientName,
  documentName,
  docNumber,
  signedByName,
}) {
  const url = `${BASE_URL}/documents`;

  await sendMail({
    to,
    subject: `[worktrips.doc] Dokument podpisany: ${documentName}`,
    html: template(`
      <h2>Dokument został podpisany</h2>
      <p>Cześć ${recipientName},</p>
      <p>Dokument <strong>${documentName}</strong> został pomyślnie podpisany elektronicznie.</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">Dokument</span>
          <span class="info-val">${documentName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Numer</span>
          <span class="info-val">${docNumber}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Podpisał</span>
          <span class="info-val">${signedByName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="info-val"><span class="badge badge-green">Podpisany ✓</span></span>
        </div>
      </div>
      <a href="${url}" class="btn">Otwórz dokument →</a>
    `),
  });
}

/**
 * Zaproszenie nowego użytkownika
 */
async function sendUserInvitation({
  to,
  displayName,
  invitedByName,
  loginUrl,
}) {
  await sendMail({
    to,
    subject: "[worktrips.doc] Zaproszenie do systemu",
    html: template(`
      <h2>Witaj w worktrips.doc!</h2>
      <p>Cześć ${displayName},</p>
      <p>Użytkownik <strong>${invitedByName}</strong> dodał Cię do systemu zarządzania dokumentami <strong>worktrips.doc</strong>.</p>
      <p>Możesz zalogować się używając swojego konta Google Workspace (<strong>${to}</strong>) przez poniższy link:</p>
      <a href="${loginUrl || BASE_URL}" class="btn">Zaloguj się →</a>
      <p style="color:#71717A;font-size:12px;margin-top:16px">
        Jeśli nie oczekiwałeś tej wiadomości, możesz ją zignorować.
      </p>
    `),
  });
}

// ─── Eksport ──────────────────────────────────────────────────────────────────

module.exports = {
  sendMail,
  sendTaskAssigned,
  sendDocumentStatusChanged,
  sendTaskCompleted,
  sendTaskRejected,
  sendDocumentSigned,
  sendUserInvitation,
};
