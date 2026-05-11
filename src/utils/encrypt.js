'use strict';
// AES-256-GCM symmetric encryption for secrets stored in DB.
// Key derived from EMAIL_ENCRYPTION_KEY env var (falls back to JWT_SECRET).
// Wire format: iv(12 bytes) + authTag(16 bytes) + ciphertext — base64-encoded.

const crypto = require('crypto');
const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.EMAIL_ENCRYPTION_KEY || process.env.JWT_SECRET || 'insecure_dev_fallback_key';
  return crypto.createHash('sha256').update(raw).digest(); // always 32 bytes
}

function encrypt(text) {
  if (!text) return null;
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(encoded) {
  if (!encoded) return null;
  try {
    const buf      = Buffer.from(encoded, 'base64');
    const iv       = buf.subarray(0, 12);
    const tag      = buf.subarray(12, 28);
    const data     = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
