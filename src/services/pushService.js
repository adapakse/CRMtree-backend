'use strict';
// services/pushService.js — push notifications to the mobile app through
// Firebase Cloud Messaging (HTTP v1).
//
// What is pushed (Adam, 2026-10-04): reminders of tasks, a newly assigned
// task, and becoming the owner of a lead or a partner. The e-mails for the
// same events keep going out; push comes on top of them.
//
// Sending is best effort and never throws: a failed or unconfigured push
// must not fail the request or the job that triggered it.

const { google } = require('googleapis');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const { translate, supportedOrDefault } = require('../utils/i18n');
const { resolveLocale } = require('../config/locales');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
// The server runs in UTC; the people reading the notification do not.
const TIME_ZONE = 'Europe/Warsaw';
const INTL_LOCALE_TAGS = { en: 'en-GB' };
const WHEN_OPTIONS = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE };

/** Talks to FCM with the service account from FIREBASE_SERVICE_ACCOUNT_JSON. */
function createFcmTransport(serviceAccountJson) {
  let credentials = null;
  if (serviceAccountJson) {
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch (error) {
      logger.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON', { error: error.message });
    }
  }
  const auth = credentials
    ? new google.auth.JWT({ email: credentials.client_email, key: credentials.private_key, scopes: [FCM_SCOPE] })
    : null;

  return {
    isConfigured: () => Boolean(auth),
    /** Resolves to 'sent', 'unregistered' (the token is dead) or 'failed'. */
    async send({ token, title, body, data, badge }) {
      // The number on the app icon: iOS shows `aps.badge`, Android launchers
      // that show a number take it from `notification_count`.
      const hasBadge = Number.isInteger(badge);
      const { token: accessToken } = await auth.getAccessToken();
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            // Without a title the message only updates the icon badge.
            token, ...(title ? { notification: { title, body } } : {}), data,
            android: { priority: 'high', ...(hasBadge ? { notification: { notification_count: badge } } : {}) },
            ...(hasBadge ? { apns: { payload: { aps: { badge } } } } : {}),
          },
        }),
      });
      if (response.ok) return 'sent';
      const text = await response.text();
      if (response.status === 404 || text.includes('UNREGISTERED')) return 'unregistered';
      logger.warn('[push] FCM refused a message', { status: response.status, response: text.slice(0, 300) });
      return 'failed';
    },
  };
}

function formatWhen(locale, value) {
  const language = supportedOrDefault(locale);
  return new Date(value).toLocaleString(INTL_LOCALE_TAGS[language] || language, WHEN_OPTIONS);
}

function createPushService(transport) {
  /**
   * Sends one notification to every phone of the given users.
   *
   * `kind` names the texts in src/i18n/push/<lang>.json; `params` fill them
   * in; `dateParams` are dates written in the recipient's language; `data`
   * tells the app what to open; `badgeByUserId` is the number to put on the
   * app icon of each recipient (a recipient without one keeps the icon as it
   * is). The tenant's name ends the body, because one phone can hold accounts
   * in several companies.
   */
  async function sendToUsers({ userIds, kind, params = {}, dateParams = {}, data = {}, badgeByUserId = null }) {
    const recipients = [...new Set((userIds || []).filter(Boolean))];
    if (!recipients.length || !transport.isConfigured()) return { sent: 0 };
    let sent = 0;
    try {
      const { rows } = await db.query(
        `SELECT pt.id, pt.token, pt.user_id, u.locale AS user_locale,
                t.default_locale AS tenant_default_locale, t.name AS tenant_name, t.slug AS tenant_slug
           FROM mobile_push_tokens pt
           JOIN users u   ON u.id = pt.user_id AND u.is_active
           JOIN tenants t ON t.id = pt.tenant_id
          WHERE pt.user_id = ANY($1::uuid[])`,
        [recipients],
      );
      for (const row of rows) {
        const locale = resolveLocale({ userLocale: row.user_locale, tenantDefaultLocale: row.tenant_default_locale });
        const textParams = { ...params };
        for (const [name, value] of Object.entries(dateParams)) {
          textParams[name] = value ? formatWhen(locale, value) : '';
        }
        const result = await transport.send({
          token: row.token,
          title: translate(locale, `push.${kind}.title`, textParams),
          body: [translate(locale, `push.${kind}.body`, textParams), row.tenant_name].filter(Boolean).join(' · '),
          // FCM data values must be strings.
          data: Object.fromEntries(
            Object.entries({ kind, tenant_slug: row.tenant_slug, ...data }).map(([key, value]) => [key, String(value)]),
          ),
          ...(badgeByUserId ? { badge: badgeByUserId[row.user_id] ?? 0 } : {}),
        });
        if (result === 'sent') sent++;
        if (result === 'unregistered') await db.query('DELETE FROM mobile_push_tokens WHERE id = $1', [row.id]);
      }
    } catch (error) {
      logger.warn('[push] Sending failed', { kind, error: error.message });
    }
    return { sent };
  }

  /**
   * Sets the number on the app icon of the user's iPhones without showing a
   * notification — after the user has read something elsewhere. Android has
   * no such number of its own: its badge follows the notifications in the
   * tray and goes away with them.
   */
  async function syncIconBadge({ userId, badge }) {
    if (!transport.isConfigured()) return { sent: 0 };
    let sent = 0;
    try {
      const { rows } = await db.query(
        `SELECT pt.id, pt.token
           FROM mobile_push_tokens pt
           JOIN users u ON u.id = pt.user_id AND u.is_active
          WHERE pt.user_id = $1 AND pt.platform = 'ios'`,
        [userId],
      );
      for (const row of rows) {
        const result = await transport.send({ token: row.token, badge });
        if (result === 'sent') sent++;
        if (result === 'unregistered') await db.query('DELETE FROM mobile_push_tokens WHERE id = $1', [row.id]);
      }
    } catch (error) {
      logger.warn('[push] Updating the icon badge failed', { error: error.message });
    }
    return { sent };
  }

  return { sendToUsers, syncIconBadge, isConfigured: () => transport.isConfigured() };
}

module.exports = {
  ...createPushService(createFcmTransport(config.push.firebaseServiceAccountJson)),
  createPushService,
};
