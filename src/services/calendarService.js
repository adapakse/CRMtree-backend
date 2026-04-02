"use strict";
// src/services/calendarService.js
// Tworzy eventy w Google Calendar używając Service Account (Domain-Wide Delegation)
// lub tokenu OAuth2 usera (jeśli SA niedostępne).

const { google } = require("googleapis");
const config     = require("../config");

// ── Buduj auth z Service Account ──────────────────────────────────────────────
function makeSAAuth(organizerEmail) {
  let keyFile = null;

  if (config.google.serviceAccountJson) {
    try {
      keyFile = JSON.parse(config.google.serviceAccountJson);
    } catch (e) {
      console.warn("[Calendar] Nieprawidłowy GOOGLE_SERVICE_ACCOUNT_JSON:", e.message);
    }
  } else if (config.google.serviceAccountFile) {
    const fs = require("fs");
    try {
      keyFile = JSON.parse(fs.readFileSync(config.google.serviceAccountFile, "utf8"));
    } catch (e) {
      console.warn("[Calendar] Nie można odczytać GOOGLE_SERVICE_ACCOUNT_FILE:", e.message);
    }
  }

  if (!keyFile) return null;

  return new google.auth.JWT({
    email:   keyFile.client_email,
    key:     keyFile.private_key,
    scopes:  ["https://www.googleapis.com/auth/calendar.events"],
    subject: organizerEmail || config.google.impersonateEmail,
  });
}

// ── Utwórz event w Google Calendar ───────────────────────────────────────────
async function createEvent({
  summary,
  description = "",
  location    = "",
  startTime,
  endTime,
  attendees   = [],
  organizerEmail,
  oauthClient = null,   // opcjonalnie — OAuth2 token usera zamiast SA
}) {
  // W środowisku deweloperskim pomiń (chyba że jawnie włączone)
  if (config.isDev && !config.google.sendInDev) {
    console.log("[Calendar] DEV — pomijam tworzenie eventu:", summary);
    return null;
  }

  let auth = oauthClient;

  if (!auth) {
    auth = makeSAAuth(organizerEmail);
  }

  if (!auth) {
    console.warn("[Calendar] Brak konfiguracji auth — pomiń tworzenie eventu");
    return null;
  }

  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary,
    description,
    location,
    start: { dateTime: startTime, timeZone: "Europe/Warsaw" },
    end:   { dateTime: endTime,   timeZone: "Europe/Warsaw" },
    attendees: attendees.map((a) =>
      typeof a === "string" ? { email: a } : a
    ),
    reminders: {
      useDefault: false,
      overrides:  [
        { method: "email", minutes: 60 },
        { method: "popup", minutes: 15 },
      ],
    },
  };

  const response = await calendar.events.insert({
    calendarId:            "primary",
    requestBody:           event,
    sendNotifications:     true,
    sendUpdates:           "all",
  });

  console.log("[Calendar] Event utworzony:", response.data.htmlLink);
  return response.data;
}

module.exports = { createEvent };
