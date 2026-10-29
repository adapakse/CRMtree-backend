"use strict";

const { matchTenantSlug, isSlugAllowed, RESERVED_SLUGS, resolveRequestHost, tenantAppUrl } = require("../config/tenantHost");

describe("tenantHost.matchTenantSlug", () => {
  test("extracts slug from a valid tenant subdomain", () => {
    expect(matchTenantSlug("acme.crmtree.pl")).toBe("acme");
    expect(matchTenantSlug("acme.crmtree.com")).toBe("acme");
    expect(matchTenantSlug("ACME.CRMTREE.PL")).toBe("acme");
    expect(matchTenantSlug("acme-corp.crmtree.pl")).toBe("acme-corp");
  });

  test("returns null for the bare base domain", () => {
    expect(matchTenantSlug("crmtree.pl")).toBeNull();
  });

  test("returns null for an unrelated domain", () => {
    expect(matchTenantSlug("acme.example.com")).toBeNull();
  });

  test("returns null for reserved infra hostnames", () => {
    expect(matchTenantSlug("app.crmtree.pl")).toBeNull();
    expect(matchTenantSlug("api.crmtree.pl")).toBeNull();
    expect(matchTenantSlug("www.crmtree.pl")).toBeNull();
  });

  test("returns null for empty/undefined host", () => {
    expect(matchTenantSlug("")).toBeNull();
    expect(matchTenantSlug(undefined)).toBeNull();
  });

  test("strips a port suffix mismatch gracefully (no match, not a crash)", () => {
    expect(matchTenantSlug("acme.crmtree.pl:4200")).toBeNull();
  });
});

describe("tenantHost.isSlugAllowed", () => {
  test("rejects every reserved slug", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isSlugAllowed(slug)).toBe(false);
    }
  });

  test("accepts an ordinary tenant slug", () => {
    expect(isSlugAllowed("acme")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isSlugAllowed("APP")).toBe(false);
  });
});

describe("tenantHost.resolveRequestHost", () => {
  test("prefers X-CRM-Tenant-Host over req.hostname/Host", () => {
    const req = { headers: { "x-crm-tenant-host": "acme.crmtree.pl" }, hostname: "api.crmtree.pl" };
    expect(resolveRequestHost(req)).toBe("acme.crmtree.pl");
  });

  test("falls back to req.hostname when the header is absent (direct API call, no proxy in front)", () => {
    const req = { headers: {}, hostname: "acme.crmtree.pl" };
    expect(resolveRequestHost(req)).toBe("acme.crmtree.pl");
  });

  test("falls back to the raw Host header when req.hostname is unavailable", () => {
    const req = { headers: { host: "acme.crmtree.pl" }, hostname: undefined };
    expect(resolveRequestHost(req)).toBe("acme.crmtree.pl");
  });

  test("returns an empty string when nothing is available", () => {
    const req = { headers: {}, hostname: undefined };
    expect(resolveRequestHost(req)).toBe("");
  });
});

describe("tenantHost.tenantAppUrl", () => {
  test("puts the company slug in place of the shared app host", () => {
    expect(tenantAppUrl("acme", "https://app.crmtree.pl")).toBe("https://acme.crmtree.pl");
    expect(tenantAppUrl("Acme", "https://app.crmtree.pl/")).toBe("https://acme.crmtree.pl");
  });

  test("keeps the shared address when the slug cannot be a host of its own", () => {
    expect(tenantAppUrl("crmtree-gold", "https://app.crmtree.pl")).toBe("https://app.crmtree.pl");
    expect(tenantAppUrl(null, "https://app.crmtree.pl")).toBe("https://app.crmtree.pl");
  });

  test("keeps the address of a non-app host (local development)", () => {
    expect(tenantAppUrl("acme", "http://localhost:4200")).toBe("http://localhost:4200");
    expect(tenantAppUrl("acme", "not a url")).toBe("not a url");
  });
});
