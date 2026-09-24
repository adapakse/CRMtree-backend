"use strict";

const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const config = require("../config");
const logger = require("../utils/logger");

let blobServiceClient;

function getClient() {
  if (blobServiceClient) return blobServiceClient;
  if (config.storage.connectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
      config.storage.connectionString,
    );
  } else {
    const credential = new StorageSharedKeyCredential(
      config.storage.accountName,
      config.storage.accountKey,
    );
    blobServiceClient = new BlobServiceClient(
      `https://${config.storage.accountName}.blob.core.windows.net`,
      credential,
    );
  }
  return blobServiceClient;
}

function getContainerClient() {
  return getClient().getContainerClient(config.storage.container);
}

// W trybie dev (Azurite) auto-tworzy kontener jeśli nie istnieje.
// Na produkcji kontener zarządza infrastruktura — bez zbędnego API call.
async function ensureContainerClient() {
  const container = getContainerClient();
  if (config.isDev) {
    await container.createIfNotExists();
  }
  return container;
}

/**
 * Upload a file buffer to Azure Blob Storage.
 * @returns {{ blobPath, blobName, blobSizeBytes }}
 */
async function uploadDocument(
  buffer,
  originalName,
  mimeType,
  documentId,
  versionNumber = 1,
) {
  const ext = path.extname(originalName);
  const blobName = `documents/${documentId}/v${versionNumber}_${uuidv4()}${ext}`;
  const container = await ensureContainerClient();

  const blockBlobClient = container.getBlockBlobClient(blobName);
  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: mimeType },
    metadata: {
      documentId,
      versionNumber: String(versionNumber),
      originalName: encodeURIComponent(originalName),
    },
  });

  logger.info("Blob uploaded", { blobName, size: buffer.length });
  return {
    blobPath: blobName,
    blobName: originalName,
    blobSizeBytes: buffer.length,
  };
}

/**
 * Download a blob as a buffer.
 */
async function downloadDocument(blobPath) {
  const blockBlobClient = getContainerClient().getBlockBlobClient(blobPath);
  const response = await blockBlobClient.download(0);
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: response.contentType,
    size: response.contentLength,
  };
}

// Both SAS helpers below must go through the same client the rest of this
// service uses (getClient()) instead of hardcoding the production
// *.blob.core.windows.net host — otherwise a local Azurite connection string
// (UseDevelopmentStorage=true) still produces a SAS URL pointing at a real
// Azure DNS name that doesn't exist, and Azurite serves plain http, so a
// SAS restricted to SASProtocol.Https would be rejected even against a
// correctly-pointed local URL.
function sasBaseUrlAndCredential() {
  const client = getClient();
  const protocol = client.url.startsWith("https")
    ? SASProtocol.Https
    : SASProtocol.HttpsAndHttp;
  return { baseUrl: client.url.replace(/\/$/, ""), credential: client.credential, protocol };
}

/**
 * Generate a short-lived SAS URL (for in-app PDF preview — read only).
 * @param {string} blobPath
 * @param {number} expiresInMinutes  default 15
 */
async function generateSasUrl(blobPath, expiresInMinutes = 15) {
  const { baseUrl, credential, protocol } = sasBaseUrlAndCredential();
  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiresInMinutes * 60 * 1000);

  const sasParams = generateBlobSASQueryParameters(
    {
      containerName: config.storage.container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
      protocol,
    },
    credential,
  );

  return `${baseUrl}/${config.storage.container}/${blobPath}?${sasParams}`;
}

/**
 * Generate a SAS URL with write permissions (for Signus to retrieve document).
 */
async function generateWriteSasUrl(blobPath, expiresInMinutes = 60) {
  const { baseUrl, credential, protocol } = sasBaseUrlAndCredential();
  const expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  const sasParams = generateBlobSASQueryParameters(
    {
      containerName: config.storage.container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("rw"),
      expiresOn,
      protocol,
    },
    credential,
  );
  return `${baseUrl}/${config.storage.container}/${blobPath}?${sasParams}`;
}

/**
 * Delete a blob.
 */
async function deleteBlob(blobPath) {
  const blockBlobClient = getContainerClient().getBlockBlobClient(blobPath);
  await blockBlobClient.deleteIfExists();
  logger.info("Blob deleted", { blobPath });
}

/**
 * Upload a raw buffer to a specific blob path (used for email attachments).
 * Unlike uploadDocument, the caller provides the full blobPath.
 * @param {string} blobPath   - e.g. 'crm-attachments/20240101-invoice.pdf'
 * @param {Buffer} buffer
 * @param {string} mimeType
 */
async function uploadBuffer(blobPath, buffer, mimeType = "application/octet-stream") {
  const container = await ensureContainerClient();
  const blockBlobClient = container.getBlockBlobClient(blobPath);
  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });
  logger.info("Buffer uploaded to blob", { blobPath, size: buffer.length });
  return blobPath;
}

module.exports = {
  uploadDocument,
  uploadBuffer,
  downloadDocument,
  generateSasUrl,
  generateWriteSasUrl,
  deleteBlob,
};
