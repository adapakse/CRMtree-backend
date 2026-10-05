"use strict";

// Push notifications of the mobile app: registering a phone, forgetting it
// on sign-out, and what is sent to it. FCM itself is replaced by a fake
// transport; nothing leaves the machine.

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const { signAccessToken } = require("../middleware/auth");
const { createPushService } = require("../services/pushService");

const DOMAIN = "push-test.crmtree.local";
const TOKEN_A = "fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb";

let tenantId;
let anna;
let piotr;
const authOf = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });

async function createUser(firstName, locale) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, crm_role, locale, tenant_id)
     VALUES ($1, $2, 'Push', TRUE, 'salesperson', $3, $4) RETURNING *`,
    [`${firstName.toLowerCase()}@${DOMAIN}`, firstName, locale, tenantId],
  );
  return user;
}

const tokensOf = async (user) =>
  (await db.query("SELECT device_id, token, platform FROM mobile_push_tokens WHERE user_id = $1 ORDER BY device_id", [user.id])).rows;

function fakeTransport({ result = "sent", isConfigured = true } = {}) {
  const sent = [];
  return { sent, isConfigured: () => isConfigured, send: async (message) => { sent.push(message); return result; } };
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Push Test Sp. z o.o.', 'zz-push-test', TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
  );
  tenantId = tenant.id;
  await db.query("DELETE FROM users WHERE email LIKE $1", [`%@${DOMAIN}`]);
  anna = await createUser("Anna", "en");
  piotr = await createUser("Piotr", "pl");
});

afterAll(async () => {
  await db.query("DELETE FROM users WHERE email LIKE $1", [`%@${DOMAIN}`]);
  await db.pool.end();
});

beforeEach(() => db.query("DELETE FROM mobile_push_tokens WHERE tenant_id = $1", [tenantId]));

describe("registering a phone", () => {
  const register = (user, deviceId, body) =>
    request(app).put(`/api/auth/devices/${deviceId}/push-token`).set(authOf(user)).send(body);

  test("stores the token for the device and replaces it when Firebase rotates it", async () => {
    expect((await register(anna, "device-anna-1", { token: TOKEN_A, platform: "android" })).status).toBe(204);
    expect((await register(anna, "device-anna-1", { token: TOKEN_B, platform: "android" })).status).toBe(204);
    expect(await tokensOf(anna)).toEqual([{ device_id: "device-anna-1", token: TOKEN_B, platform: "android" }]);
  });

  test("a token registered by another account on the same phone moves to the new one", async () => {
    await register(anna, "shared-phone-1", { token: TOKEN_A, platform: "android" });
    await register(piotr, "shared-phone-1", { token: TOKEN_A, platform: "android" });
    expect(await tokensOf(anna)).toEqual([]);
    expect(await tokensOf(piotr)).toHaveLength(1);
  });

  test("rejects a missing token, an unknown platform and an anonymous call", async () => {
    expect((await register(anna, "device-anna-1", { platform: "android" })).status).toBe(400);
    expect((await register(anna, "device-anna-1", { token: TOKEN_A, platform: "windows" })).status).toBe(400);
    expect((await request(app).put("/api/auth/devices/device-anna-1/push-token").send({ token: TOKEN_A, platform: "ios" })).status).toBe(401);
  });

  test("removing the token, or signing the device out from the web, stops the notifications", async () => {
    await register(anna, "device-anna-1", { token: TOKEN_A, platform: "android" });
    expect((await request(app).delete("/api/auth/devices/device-anna-1/push-token").set(authOf(anna))).status).toBe(204);
    expect(await tokensOf(anna)).toEqual([]);

    await register(anna, "device-anna-2", { token: TOKEN_B, platform: "ios" });
    // No live session for that device, so the sign-out itself answers 404 — the token still goes.
    await request(app).delete("/api/auth/devices/device-anna-2").set(authOf(anna));
    expect(await tokensOf(anna)).toEqual([]);
  });
});

describe("sending", () => {
  const seedToken = (user, token) => db.query(
    "INSERT INTO mobile_push_tokens (tenant_id, user_id, device_id, token, platform) VALUES ($1, $2, $3, $4, 'android')",
    [tenantId, user.id, `device-${token.slice(-4)}`, token],
  );
  const reminder = (userIds) => ({
    userIds,
    kind: "activityReminder",
    params: { title: "Call back", sourceName: "Vantex" },
    dateParams: { when: "2026-10-06T08:00:00.000Z" },
    data: { source_type: "lead", source_id: 12, activity_id: 5 },
  });

  test("each recipient gets the text in their own language, with the company at the end", async () => {
    await seedToken(anna, TOKEN_A);
    await seedToken(piotr, TOKEN_B);
    const transport = fakeTransport();

    const result = await createPushService(transport).sendToUsers(reminder([anna.id, piotr.id, anna.id]));

    expect(result).toEqual({ sent: 2 });
    const byToken = Object.fromEntries(transport.sent.map((message) => [message.token, message]));
    expect(byToken[TOKEN_A].title).toBe("Reminder: Call back");
    // 08:00 UTC is 10:00 in Warsaw, where the people reading it are.
    expect(byToken[TOKEN_A].body).toBe("Vantex · 06/10, 10:00 · Push Test Sp. z o.o.");
    expect(byToken[TOKEN_B].title).toBe("Przypomnienie: Call back");
    // The app needs strings to route the tap.
    expect(byToken[TOKEN_A].data).toEqual({
      kind: "activityReminder", tenant_slug: "zz-push-test", source_type: "lead", source_id: "12", activity_id: "5",
    });
  });

  test("a token Firebase no longer knows is forgotten", async () => {
    await seedToken(anna, TOKEN_A);
    const result = await createPushService(fakeTransport({ result: "unregistered" })).sendToUsers(reminder([anna.id]));
    expect(result).toEqual({ sent: 0 });
    expect(await tokensOf(anna)).toEqual([]);
  });

  test("without Firebase credentials nothing is sent and nothing fails", async () => {
    await seedToken(anna, TOKEN_A);
    const transport = fakeTransport({ isConfigured: false });
    expect(await createPushService(transport).sendToUsers(reminder([anna.id]))).toEqual({ sent: 0 });
    expect(transport.sent).toEqual([]);
    expect(await tokensOf(anna)).toHaveLength(1);
  });

  test("a transport that throws does not break the caller", async () => {
    await seedToken(anna, TOKEN_A);
    const transport = { isConfigured: () => true, send: async () => { throw new Error("network down"); } };
    await expect(createPushService(transport).sendToUsers(reminder([anna.id]))).resolves.toEqual({ sent: 0 });
  });

  test("every kind of notification has its texts in all ten languages", () => {
    const { translate } = require("../utils/i18n");
    const kinds = ["activityReminder", "activityAssigned", "projectTaskReminder", "projectTaskAssigned", "leadOwnerAssigned", "partnerOwnerAssigned"];
    for (const locale of ["pl", "en", "de", "it", "es", "fr", "ro", "ru", "sl", "hr"]) {
      for (const kind of kinds) {
        for (const part of ["title", "body"]) {
          const key = `push.${kind}.${part}`;
          expect(translate(locale, key, {})).not.toBe(key);
        }
      }
    }
  });
});
