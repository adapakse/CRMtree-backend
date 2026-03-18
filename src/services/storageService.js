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
  const container = getContainerClient();

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

/**
 * Generate a short-lived SAS URL (for in-app PDF preview — read only).
 * @param {string} blobPath
 * @param {number} expiresInMinutes  default 15
 */
async function generateSasUrl(blobPath, expiresInMinutes = 15) {
  const credential = new StorageSharedKeyCredential(
    config.storage.accountName,
    config.storage.accountKey,
  );
  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiresInMinutes * 60 * 1000);

  const sasParams = generateBlobSASQueryParameters(
    {
      containerName: config.storage.container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    credential,
  );

  return `https://${config.storage.accountName}.blob.core.windows.net/${config.storage.container}/${blobPath}?${sasParams}`;
}

/**
 * Generate a SAS URL with write permissions (for Signus to retrieve document).
 */
async function generateWriteSasUrl(blobPath, expiresInMinutes = 60) {
  const credential = new StorageSharedKeyCredential(
    config.storage.accountName,
    config.storage.accountKey,
  );
  const expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  const sasParams = generateBlobSASQueryParameters(
    {
      containerName: config.storage.container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("rw"),
      expiresOn,
      protocol: SASProtocol.Https,
    },
    credential,
  );
  return `https://${config.storage.accountName}.blob.core.windows.net/${config.storage.container}/${blobPath}?${sasParams}`;
}

/**
 * Delete a blob.
 */
async function deleteBlob(blobPath) {
  const blockBlobClient = getContainerClient().getBlockBlobClient(blobPath);
  await blockBlobClient.deleteIfExists();
  logger.info("Blob deleted", { blobPath });
}

module.exports = {
  uploadDocument,
  downloadDocument,
  generateSasUrl,
  generateWriteSasUrl,
  deleteBlob,
};
