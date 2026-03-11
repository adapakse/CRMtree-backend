'use strict';

const nodemailer = require('nodemailer');
const config     = require('../config');
const logger     = require('../utils/logger');

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host:   config.email.host,
    port:   config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
  });
  return transporter;
}

const FROM = `"${config.email.fromName}" <${config.email.from}>`;
const APP  = config.appUrl;

// ─── HTML Template wrapper ─────────────────────────────────
function wrap(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f5;margin:0;padding:24px;}
    .card{background:white;border-radius:12px;max-width:560px;margin:0 auto;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,.08);}
    .header{background:#18181B;padding:24px 32px;display:flex;align-items:center;gap:12px;}
    .logo-dot{width:32px;height:32px;background:#F26522;border-radius:8px;}
    .logo-text{color:white;font-size:16px;font-weight:700;letter-spacing:-.2px;}
    .logo-text span{color:#F26522;}
    .body{padding:28px 32px;}
    h2{font-size:18px;font-weight:700;color:#18181B;margin:0 0 16px;}
    p{font-size:14px;color:#3F3F46;line-height:1.6;margin:0 0 12px;}
    .doc-box{background:#FAFAFA;border:1px solid #E4E4E7;border-radius:8px;padding:14px 16px;margin:16px 0;}
    .doc-num{font-size:11px;font-weight:700;color:#71717A;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
    .doc-name{font-size:15px;font-weight:600;color:#18181B;}
    .btn{display:inline-block;background:#F26522;color:white;padding:11px 22px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-top:8px;}
    .footer{padding:16px 32px;background:#FAFAFA;border-top:1px solid #E4E4E7;font-size:12px;color:#A1A1AA;}
  </style></head><body>
  <div class="card">
    <div class="header">
      <div class="logo-dot"></div>
      <div class="logo-text">worktrips<span>.doc</span></div>
    </div>
    <div class="body">${body}</div>
    <div class="footer">worktrips.doc — Document Management System · worktrips.com</div>
  </div></body></html>`;
}

// ─── Email: Workflow task assigned ────────────────────────
async function sendWorkflowAssignment({ to, assigneeName, assignerName, document, taskType, message, dueDate }) {
  const taskLabels = { read: 'Read', edit: 'Edit', approve: 'Approve', sign: 'Sign' };
  const taskLabel  = taskLabels[taskType] || taskType;

  const body = `
    <h2>You have a new task: ${taskLabel}</h2>
    <p>Hi ${assigneeName},</p>
    <p>${assignerName} has assigned you a <strong>${taskLabel}</strong> task on the following document:</p>
    <div class="doc-box">
      <div class="doc-num">${document.docNumber}</div>
      <div class="doc-name">${document.name}</div>
    </div>
    ${message ? `<p><strong>Message:</strong> ${message}</p>` : ''}
    ${dueDate  ? `<p><strong>Due date:</strong> ${dueDate}</p>` : ''}
    <a href="${APP}/documents/${document.id}" class="btn">Open Document →</a>
  `;

  await send({
    to,
    subject: `[worktrips.doc] Action required: ${taskLabel} — ${document.name}`,
    html:    wrap(`Task: ${taskLabel}`, body),
  });
}

// ─── Email: Document signed ───────────────────────────────
async function sendSigningNotification({ to, ownerName, signatoryName, signatoryEmail, document }) {
  const body = `
    <h2>Document signed</h2>
    <p>Hi ${ownerName},</p>
    <p>Your document has been signed by <strong>${signatoryName}</strong> (${signatoryEmail}):</p>
    <div class="doc-box">
      <div class="doc-num">${document.docNumber}</div>
      <div class="doc-name">${document.name}</div>
    </div>
    <p>The signed version has been automatically archived and is available for download.</p>
    <a href="${APP}/documents/${document.id}" class="btn">View Document →</a>
  `;

  await send({
    to,
    subject: `[worktrips.doc] Document signed by ${signatoryName} — ${document.name}`,
    html:    wrap('Document Signed', body),
  });
}

// ─── Email: Document expiring soon ───────────────────────
async function sendExpiryWarning({ to, ownerName, document, daysLeft }) {
  const body = `
    <h2>Document expiring soon</h2>
    <p>Hi ${ownerName},</p>
    <p>The following document will expire in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>:</p>
    <div class="doc-box">
      <div class="doc-num">${document.docNumber}</div>
      <div class="doc-name">${document.name}</div>
    </div>
    <p>Expiration date: <strong>${document.expirationDate}</strong></p>
    <a href="${APP}/documents/${document.id}" class="btn">Review Document →</a>
  `;

  await send({
    to,
    subject: `[worktrips.doc] Document expiring soon — ${document.name}`,
    html:    wrap('Expiry Warning', body),
  });
}

// ─── Low-level send ───────────────────────────────────────
async function send({ to, subject, html, text }) {
  if (!config.email.pass && config.isDev) {
    logger.info('Email (dev mock)', { to, subject });
    return;
  }
  try {
    const info = await getTransporter().sendMail({ from: FROM, to, subject, html, text });
    logger.info('Email sent', { messageId: info.messageId, to, subject });
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    // Don't throw — email failures are non-fatal
  }
}

module.exports = { sendWorkflowAssignment, sendSigningNotification, sendExpiryWarning, send };
