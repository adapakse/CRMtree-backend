"use strict";

// GET /api/auth/google and /google/callback. Google itself is mocked (no network);
// everything else (tenants, users, sessions, audit) runs against the test DB.

jest.mock("../services/googleLogin", () => ({
  isConfigured: jest.fn(() => true),
  buildAuthUrl: jest.fn(({ state, nonce }) => "https://accounts.google.test/auth?state=" + state + "&nonce=" + nonce),
  exchangeCodeForIdentity: jest.fn(),
}));

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const config = require("../config");
const googleLogin = require("../services/googleLogin");
const { signGoogleState } = require("../utils/googleLoginState");

const DOMAIN = "google-login-test.crmtree.local";
const DEVICE = "device-test-0001";
let tenantA, tenantB, tenantSuspended;
const slugs = { a: "zz-glogin-a", b: "zz-glogin-b", s: "zz-glogin-s" };

async function upsertTenant(name, slug, isActive = true) {
  const { rows: [t] } = await db.query(
    "INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, $3) " +
    "ON CONFLICT (slug) DO UPDATE SET is_active = $3, deleted_at = NULL RETURNING id",
    [name, slug, isActive],
  );
  return t.id;
}
const createUser = (email, tenantId, crmRole, isActive = true) => db.query(
  "INSERT INTO users (email, first_name, last_name, is_active, crm_role, tenant_id) VALUES ($1, 'G', 'Login', $2, $3, $4)",
  [email, isActive, crmRole, tenantId]);

// Runs the callback as the browser would: signed state + matching nonce cookie.
function callback({ client = "web", host = "", identity, query = {} }) {
  const { state, nonce } = signGoogleState({ client, deviceId: client === "mobile" ? DEVICE : null, host });
  if (identity) googleLogin.exchangeCodeForIdentity.mockResolvedValueOnce(identity);
  return request(app).get("/api/auth/google/callback")
    .set("Cookie", "crmtree_glogin=" + nonce)
    .query({ state, code: "auth-code", ...query });
}
const ok = (email) => ({ email, emailVerified: true });
const mobileQuery = (res) => new URL(res.headers.location.replace("crmtree://", "http://")).searchParams;
const webError = (res) => new URL(res.headers.location).searchParams.get("error");

beforeAll(async () => {
  config.google.clientId = "test-client";
  config.google.clientSecret = "test-secret";
  config.google.loginRedirectUri = "https://app.int.crmtree.pl/api/auth/google/callback";
  tenantA = await upsertTenant("Google Login A", slugs.a);
  tenantB = await upsertTenant("Google Login B", slugs.b);
  tenantSuspended = await upsertTenant("Google Login S", slugs.s, false);
  const ids = [tenantA, tenantB, tenantSuspended];
  await db.query("DELETE FROM audit_logs WHERE tenant_id = ANY($1)", [ids]);
  await db.query("DELETE FROM refresh_tokens WHERE tenant_id = ANY($1)", [ids]);
  await db.query("DELETE FROM users WHERE email LIKE $1", ["%@" + DOMAIN]);
  await createUser("solo@" + DOMAIN, tenantA, "salesperson");
  await createUser("multi@" + DOMAIN, tenantA, "salesperson");
  await createUser("multi@" + DOMAIN, tenantB, "sales_manager");
  await createUser("inactive@" + DOMAIN, tenantA, "salesperson", false);
  await createUser("suspended@" + DOMAIN, tenantSuspended, "salesperson");
  await createUser("admin@" + DOMAIN, tenantA, null);
});

afterAll(async () => {
  const ids = [tenantA, tenantB, tenantSuspended];
  await db.query("DELETE FROM audit_logs WHERE tenant_id = ANY($1)", [ids]);
  await db.query("DELETE FROM refresh_tokens WHERE tenant_id = ANY($1)", [ids]);
  await db.query("DELETE FROM users WHERE email LIKE $1", ["%@" + DOMAIN]);
});

describe("GET /api/auth/google", () => {
  it("answers 503 when GOOGLE_LOGIN_REDIRECT_URI is not configured", async () => {
    googleLogin.isConfigured.mockReturnValueOnce(false);
    const res = await request(app).get("/api/auth/google");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("google_not_configured");
  });

  it("redirects to Google with a signed state and sets the nonce cookie", async () => {
    const res = await request(app).get("/api/auth/google").query({ client: "web" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=g1\./);
    const cookie = res.headers["set-cookie"].join(";");
    expect(cookie).toMatch(/crmtree_glogin=/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("requires a valid device_id for mobile", async () => {
    const res = await request(app).get("/api/auth/google").query({ client: "mobile", device_id: "x" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/auth/google/callback - redirect shapes", () => {
  it("web: redirects to the frontend with tokens and logs google_oauth", async () => {
    const res = await callback({ identity: ok("  SOLO@" + DOMAIN + " ") });
    expect(res.status).toBe(302);
    const u = new URL(res.headers.location);
    expect(u.origin + u.pathname).toBe(config.frontendUrl + "/auth/callback");
    expect(u.searchParams.get("access_token")).toBeTruthy();
    expect(u.searchParams.get("refresh_token")).toBeTruthy();
    const { rows } = await db.query(
      "SELECT metadata FROM audit_logs WHERE tenant_id = $1 AND action = 'user_login' ORDER BY created_at DESC LIMIT 1", [tenantA]);
    expect(rows[0].metadata.method).toBe("google_oauth");
  });

  it("mobile: redirects to crmtree:// with tokens and tenant fields", async () => {
    const res = await callback({ client: "mobile", identity: ok("solo@" + DOMAIN) });
    expect(res.headers.location.startsWith("crmtree://auth/callback?")).toBe(true);
    const q = mobileQuery(res);
    expect(q.get("access_token")).toBeTruthy();
    expect(q.get("refresh_token")).toBeTruthy();
    expect(q.get("tenant_slug")).toBe(slugs.a);
    expect(q.get("tenant_name")).toBe("Google Login A");
  });

  it("mobile with several companies: returns an accounts list", async () => {
    const res = await callback({ client: "mobile", identity: ok("multi@" + DOMAIN) });
    const accounts = JSON.parse(Buffer.from(mobileQuery(res).get("accounts"), "base64url").toString());
    expect(accounts.map((a) => a.tenant_slug).sort()).toEqual([slugs.a, slugs.b]);
    expect(accounts[0].access_token).toBeTruthy();
  });
});

describe("GET /api/auth/google/callback - e-mail matching rules", () => {
  it("no matching user -> no_account (no auto-registration)", async () => {
    const res = await callback({ identity: ok("nobody@" + DOMAIN) });
    expect(new URL(res.headers.location).pathname).toBe("/login");
    expect(webError(res)).toBe("no_account");
  });

  it("unverified Google e-mail -> email_not_verified", async () => {
    const res = await callback({ identity: { email: "solo@" + DOMAIN, emailVerified: false } });
    expect(webError(res)).toBe("email_not_verified");
  });

  it("inactive user -> account_inactive", async () => {
    expect(webError(await callback({ identity: ok("inactive@" + DOMAIN) }))).toBe("account_inactive");
  });

  it("suspended tenant -> tenant_suspended", async () => {
    expect(webError(await callback({ identity: ok("suspended@" + DOMAIN) }))).toBe("tenant_suspended");
  });

  it("mobile with a non-sales role -> role_not_allowed", async () => {
    const res = await callback({ client: "mobile", identity: ok("admin@" + DOMAIN) });
    expect(res.headers.location).toBe("crmtree://auth/callback?error=role_not_allowed");
  });

  it("tenant host: only that tenant's user counts", async () => {
    const own = await callback({ host: slugs.b + ".crmtree.pl", identity: ok("multi@" + DOMAIN) });
    expect(own.headers.location).toContain("/auth/callback?access_token=");
    const other = await callback({ host: slugs.b + ".crmtree.pl", identity: ok("solo@" + DOMAIN) });
    expect(webError(other)).toBe("no_account");
  });

  it("unknown tenant host -> no_account", async () => {
    const res = await callback({ host: "zz-no-such-tenant.crmtree.pl", identity: ok("solo@" + DOMAIN) });
    expect(webError(res)).toBe("no_account");
  });

  it("shared host with several companies still logs in (web, deterministic pick)", async () => {
    const res = await callback({ identity: ok("multi@" + DOMAIN) });
    expect(res.headers.location).toContain("/auth/callback?access_token=");
  });
});

describe("GET /api/auth/google/callback - CSRF and Google failures", () => {
  it("rejects a callback without the nonce cookie", async () => {
    const { state } = signGoogleState({ client: "web" });
    const res = await request(app).get("/api/auth/google/callback").query({ state, code: "c" });
    expect(webError(res)).toBe("google_state_invalid");
  });

  it("rejects a forged state", async () => {
    const res = await request(app).get("/api/auth/google/callback").query({ state: "g1.a.b", code: "c" });
    expect(webError(res)).toBe("google_state_invalid");
  });

  it("maps a denied consent to google_denied and a failed exchange to google_failed", async () => {
    const denied = await callback({ client: "mobile", query: { error: "access_denied", code: undefined } });
    expect(denied.headers.location).toBe("crmtree://auth/callback?error=google_denied");
    googleLogin.exchangeCodeForIdentity.mockRejectedValueOnce(new Error("bad token"));
    const failed = await callback({ client: "mobile" });
    expect(failed.headers.location).toBe("crmtree://auth/callback?error=google_failed");
  });
});
