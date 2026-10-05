'use strict';
// A fake KSeF for tests: answers the calls of ksefApiClient through a
// replacement for global.fetch, with a real RSA key pair behind it — so the
// token and the export key really are encrypted by the code under test and
// really decrypted here, and export parts really are AES-encrypted ZIP slices.

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const BASE_URL = 'https://api-test.ksef.mf.gov.pl/v2';
const PARTS_URL = 'https://ksef-parts.example.test';
const SHA256_WITH_RSA_OID = Buffer.from('06092a864886f70d01010b', 'hex');
const COMMON_NAME_OID = Buffer.from('0603550403', 'hex');

function der(tag, content) {
  const length = content.length;
  let header;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else if (length < 0x100) header = Buffer.from([tag, 0x81, length]);
  else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
}

const sequence = (...items) => der(0x30, Buffer.concat(items));

// Node cannot issue certificates, and the client reads KSeF's public key from
// an X.509 certificate — so a minimal self-signed one is assembled by hand.
function buildSelfSignedCertificate({ publicKey, privateKey }) {
  const algorithm = sequence(SHA256_WITH_RSA_OID, der(0x05, Buffer.alloc(0)));
  const name = sequence(der(0x31, sequence(COMMON_NAME_OID, der(0x0c, Buffer.from('ksef-test')))));
  const validity = sequence(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('450101000000Z')));
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm, name, validity, name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', toBeSigned, privateKey);
  return sequence(toBeSigned, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature]))).toString('base64');
}

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificate = buildSelfSignedCertificate(keyPair);

function rsaDecrypt(base64) {
  return crypto.privateDecrypt(
    { key: keyPair.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(base64, 'base64'),
  );
}

const sha256Base64 = (buffer) => crypto.createHash('sha256').update(buffer).digest('base64');

function jsonResponse(status, payload, headers = {}) {
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const errorBody = (description) => ({
  exception: { exceptionDetailList: [{ exceptionCode: 21000, exceptionDescription: description }] },
});

function buildZip(invoices) {
  const zip = new AdmZip();
  zip.addFile('_metadata.json', Buffer.from(JSON.stringify({ invoices: invoices.map((invoice) => invoice.metadata) })));
  for (const invoice of invoices) {
    if (invoice.xml) zip.addFile(`${invoice.metadata.ksefNumber}.xml`, Buffer.from(invoice.xml, 'utf8'));
  }
  return zip.toBuffer();
}

// Splits `plain` into `partCount` slices and encrypts each one on its own,
// the way KSeF does. Returns [{ descriptor, encrypted }].
function encryptParts(plain, { key, initializationVector, partCount = 1, urlPrefix = PARTS_URL }) {
  const sliceSize = Math.ceil(plain.length / partCount);
  return Array.from({ length: partCount }, (unused, index) => {
    const slice = plain.subarray(index * sliceSize, (index + 1) * sliceSize);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, initializationVector);
    const encrypted = Buffer.concat([cipher.update(slice), cipher.final()]);
    return {
      encrypted,
      descriptor: {
        ordinalNumber: index + 1,
        partName: `part-${index + 1}.zip.aes`,
        method: 'GET',
        url: `${urlPrefix}/${index + 1}`,
        partSize: slice.length,
        partHash: sha256Base64(slice),
        encryptedPartSize: encrypted.length,
        encryptedPartHash: sha256Base64(encrypted),
      },
    };
  });
}

// `validToken` is the only KSeF token the fake accepts.
function createKsefMock({ validToken = 'valid-ksef-token' } = {}) {
  const mock = {
    validToken,
    calls: [],
    exportRequests: [],
    // Scripted results of the next exports, in order. Each: { invoices, isTruncated,
    // lastPermanentStorageDate, permanentStorageHwmDate, partCount, isEmpty, corruptPart, failureCode }.
    exportScript: [],
    // 'status' = the token is accepted over HTTP but the authentication ends rejected.
    authRejection: null,
    serverErrorPaths: new Set(),
    rateLimits: [],
    accessTokenLifetimeMs: 15 * 60_000,
    isRefreshRefused: false,
    counters: { authentications: 0, refreshes: 0 },
  };
  const exportsByReference = new Map();
  const partsByUrl = new Map();

  mock.callsTo = (method, pathPrefix) => mock.calls.filter(
    (call) => call.method === method && call.path.startsWith(pathPrefix),
  );
  mock.rateLimitOnce = (method, pathPrefix, retryAfter) => {
    mock.rateLimits.push({ method, pathPrefix, retryAfter });
  };

  const newTokens = () => ({
    accessToken: {
      token: `access-${crypto.randomUUID()}`,
      validUntil: new Date(Date.now() + mock.accessTokenLifetimeMs).toISOString(),
    },
    refreshToken: { token: 'refresh-token', validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  });

  function startExport(body) {
    const script = mock.exportScript.shift() || { isEmpty: true };
    const referenceNumber = `EXPORT-${exportsByReference.size + 1}`;
    mock.exportRequests.push(body);
    let exportPackage = null;
    if (!script.isEmpty) {
      const parts = encryptParts(buildZip(script.invoices || []), {
        key: rsaDecrypt(body.encryption.encryptedSymmetricKey),
        initializationVector: Buffer.from(body.encryption.initializationVector, 'base64'),
        partCount: script.partCount || 1,
        urlPrefix: `${PARTS_URL}/${referenceNumber}`,
      });
      for (const part of parts) {
        const content = script.corruptPart ? Buffer.concat([part.encrypted, Buffer.from([1])]) : part.encrypted;
        partsByUrl.set(part.descriptor.url, content);
      }
      exportPackage = {
        invoiceCount: (script.invoices || []).length,
        isTruncated: Boolean(script.isTruncated),
        lastPermanentStorageDate: script.lastPermanentStorageDate || null,
        permanentStorageHwmDate: script.permanentStorageHwmDate || null,
        parts: parts.map((part) => part.descriptor),
      };
    }
    exportsByReference.set(referenceNumber, { exportPackage, failureCode: script.failureCode || null });
    return jsonResponse(201, { referenceNumber });
  }

  function route(method, path, { authorization, body }) {
    if (method === 'POST' && path === '/auth/challenge') {
      return jsonResponse(200, { challenge: 'challenge-1', timestamp: new Date().toISOString(), timestampMs: 1700000000123 });
    }
    if (method === 'GET' && path === '/security/public-key-certificates') {
      return jsonResponse(200, [
        { certificate, usage: ['KsefTokenEncryption'] },
        { certificate, usage: ['SymmetricKeyEncryption'] },
      ]);
    }
    if (method === 'POST' && path === '/auth/ksef-token') {
      const decrypted = rsaDecrypt(body.encryptedToken).toString('utf8');
      if (decrypted !== `${mock.validToken}|1700000000123`) return jsonResponse(401, errorBody('Invalid token'));
      mock.lastAuthBody = body;
      mock.counters.authentications += 1;
      return jsonResponse(202, { referenceNumber: 'AUTH-1', authenticationToken: { token: 'authentication-token' } });
    }
    if (method === 'GET' && path === '/auth/AUTH-1') {
      if (authorization !== 'Bearer authentication-token') return jsonResponse(401, errorBody('Unauthorized'));
      if (mock.authRejection === 'status') {
        return jsonResponse(200, { status: { code: 450, description: 'Token revoked', details: ['revoked by owner'] } });
      }
      return jsonResponse(200, { status: { code: 200, description: 'OK' } });
    }
    if (method === 'POST' && path === '/auth/token/redeem') {
      if (authorization !== 'Bearer authentication-token') return jsonResponse(401, errorBody('Unauthorized'));
      return jsonResponse(200, newTokens());
    }
    if (method === 'POST' && path === '/auth/token/refresh') {
      if (mock.isRefreshRefused || authorization !== 'Bearer refresh-token') {
        return jsonResponse(401, errorBody('Refresh token expired'));
      }
      mock.counters.refreshes += 1;
      return jsonResponse(200, { accessToken: newTokens().accessToken });
    }
    if (!authorization?.startsWith('Bearer access-')) return jsonResponse(401, errorBody('Unauthorized'));
    if (method === 'POST' && path === '/invoices/exports') return startExport(body);
    if (method === 'GET' && path.startsWith('/invoices/exports/')) {
      const started = exportsByReference.get(path.split('/').pop());
      if (started.failureCode) {
        return jsonResponse(200, { status: { code: started.failureCode, description: 'Export failed' } });
      }
      return jsonResponse(200, { status: { code: 200, description: 'OK' }, package: started.exportPackage });
    }
    return jsonResponse(404, errorBody('Not found'));
  }

  mock.fetch = async (input, options = {}) => {
    const url = String(input);
    const method = options.method || 'GET';
    const authorization = options.headers?.Authorization || null;
    if (url.startsWith(PARTS_URL)) {
      mock.calls.push({ method, path: url, authorization });
      const content = partsByUrl.get(url);
      return content ? new Response(content, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (!url.startsWith(BASE_URL)) throw new TypeError(`Unexpected request in a test: ${url}`);
    const path = url.slice(BASE_URL.length);
    mock.calls.push({ method, path, authorization });

    const limitIndex = mock.rateLimits.findIndex(
      (limit) => limit.method === method && path.startsWith(limit.pathPrefix),
    );
    if (limitIndex >= 0) {
      const [limit] = mock.rateLimits.splice(limitIndex, 1);
      return jsonResponse(429, errorBody('Too many requests'), { 'Retry-After': String(limit.retryAfter) });
    }
    if ([...mock.serverErrorPaths].some((prefix) => path.startsWith(prefix))) {
      return jsonResponse(500, errorBody('Internal error'));
    }
    return route(method, path, { authorization, body: options.body ? JSON.parse(options.body) : undefined });
  };

  return mock;
}

module.exports = { createKsefMock, encryptParts, buildZip, sha256Base64 };
