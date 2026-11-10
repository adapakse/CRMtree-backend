"use strict";

const dns = require("dns");
const net = require("net");

// Addresses a crawler must never reach: loopback, private networks, link-local
// (incl. the cloud metadata endpoint 169.254.169.254) and their IPv6 forms.
// Crawled URLs come from imports, search results, AI and manual corrections.
const blockedAddresses = new net.BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) {
  blockedAddresses.addSubnet(subnet, prefix, "ipv4");
}
for (const [subnet, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]]) {
  blockedAddresses.addSubnet(subnet, prefix, "ipv6");
}

function isBlockedAddress(address, family) {
  const isV6 = family === 6 || family === "IPv6" || net.isIPv6(address);
  if (isV6) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked as the IPv4 address it carries.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blockedAddresses.check(mapped[1], "ipv4");
    return blockedAddresses.check(address, "ipv6");
  }
  return blockedAddresses.check(address, "ipv4");
}

// A literal IP in the URL never reaches DNS lookup, so it is checked separately.
function assertPublicHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host, net.isIP(host))) {
    const error = new Error(`Refusing to connect to non-public address ${host}`);
    error.code = "EBLOCKEDADDRESS";
    throw error;
  }
}

/**
 * Drop-in `lookup` for axios/http: resolves like dns.lookup, but fails when the
 * host resolves to a non-public address. Runs on every connection, so redirects
 * to internal hosts are refused too.
 */
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const resolved = Array.isArray(address) ? address : [{ address, family }];
    const blocked = resolved.find((entry) => isBlockedAddress(entry.address, entry.family));
    if (blocked) {
      const error = new Error(`Refusing to connect to non-public address for ${hostname}`);
      error.code = "EBLOCKEDADDRESS";
      return callback(error);
    }
    return callback(null, address, family);
  });
}

module.exports = { publicOnlyLookup, assertPublicHost, isBlockedAddress };
