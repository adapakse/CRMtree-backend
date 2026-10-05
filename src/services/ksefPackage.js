'use strict';
// services/ksefPackage.js
//
// Turns the parts of a KSeF invoice export into its content: every part is an
// AES-256-CBC encrypted slice of one ZIP holding `_metadata.json` and one
// `<ksefNumber>.xml` per invoice. No network, no database.

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const METADATA_ENTRY = '_metadata.json';
const XML_SUFFIX = '.xml';

function sha256Base64(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64');
}

// Each part is encrypted on its own (same key and IV, PKCS#7 padding), so the
// parts are decrypted one by one and only then joined.
function decryptPart({ part, encrypted, key, initializationVector }) {
  if (sha256Base64(encrypted) !== part.encryptedPartHash) {
    throw new Error(`KSeF export part ${part.ordinalNumber}: encrypted content hash mismatch`);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, initializationVector);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (sha256Base64(plain) !== part.partHash) {
    throw new Error(`KSeF export part ${part.ordinalNumber}: decrypted content hash mismatch`);
  }
  return plain;
}

function readZip(zipBuffer) {
  const xmlByKsefNumber = new Map();
  let invoices = [];
  for (const entry of new AdmZip(zipBuffer).getEntries()) {
    if (entry.isDirectory) continue;
    if (entry.entryName === METADATA_ENTRY) {
      const metadata = JSON.parse(entry.getData().toString('utf8'));
      if (Array.isArray(metadata?.invoices)) invoices = metadata.invoices;
    } else if (entry.entryName.toLowerCase().endsWith(XML_SUFFIX)) {
      xmlByKsefNumber.set(entry.entryName.slice(0, -XML_SUFFIX.length), entry.getData().toString('utf8'));
    }
  }
  return { invoices, xmlByKsefNumber };
}

// `downloadPart(part)` resolves with the encrypted bytes of one part.
// Returns { invoices: metadata entries, xmlByKsefNumber: Map }.
async function openExportPackage({ exportPackage, key, initializationVector, downloadPart }) {
  const parts = [...exportPackage.parts].sort((a, b) => a.ordinalNumber - b.ordinalNumber);
  const decryptedParts = [];
  for (const part of parts) {
    const encrypted = await downloadPart(part);
    decryptedParts.push(decryptPart({ part, encrypted, key, initializationVector }));
  }
  return readZip(Buffer.concat(decryptedParts));
}

module.exports = { sha256Base64, openExportPackage };
