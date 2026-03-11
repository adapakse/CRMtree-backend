'use strict';

const axios   = require('axios');
const crypto  = require('crypto');
const config  = require('../config');
const logger  = require('../utils/logger');
const storage = require('./storageService');
const db      = require('../config/database');
const audit   = require('./auditService');
const email   = require('./emailService');

const signusClient = axios.create({
  baseURL: config.signus.baseUrl,
  headers: {
    'Authorization': `Bearer ${config.signus.apiKey}`,
    'Content-Type':  'application/json',
  },
  timeout: 30000,
});

/**
 * Initiate an e-signing envelope via Signus API.
 *
 * Flow:
 *  1. Generate short-lived SAS URL for the document blob
 *  2. POST to Signus /envelopes with signatories + callback URL
 *  3. Save envelope_id to document record
 *  4. Return redirect URL for frontend
 */
async function initiateSign({ documentId, blobPath, documentName, docNumber, signatories, initiatedBy, client }) {
  const q = client ? client.query.bind(client) : db.query;

  // 1. Generate SAS URL (60 min — Signus needs time to process)
  const sasUrl = await storage.generateSasUrl(blobPath, 60);

  // 2. Call Signus API
  let envelopeResponse;
  try {
    envelopeResponse = await signusClient.post('/envelopes', {
      document: {
        url:  sasUrl,
        name: documentName,
        reference: docNumber,
      },
      signatories: signatories.map((s, idx) => ({
        email:     s.email,
        full_name: s.name || s.email,
        order:     idx + 1,
      })),
      callback_url: `${config.appUrl}/api/signing/webhook`,
      settings: {
        send_email_notifications: true,
        redirect_url_after_sign:  `${config.appUrl}/signing/complete`,
      },
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Signus initiate error', { documentId, error: msg });
    throw new Error(`Signus API error: ${msg}`);
  }

  const { envelope_id, redirect_url } = envelopeResponse.data;

  // 3. Persist envelope_id and update status
  await q(
    `UPDATE documents
     SET signus_envelope_id = $1,
         status = 'being_signed'::doc_status,
         updated_at = NOW()
     WHERE id = $2`,
    [envelope_id, documentId]
  );

  logger.info('Signus envelope created', { documentId, envelope_id });

  return { envelopeId: envelope_id, redirectUrl: redirect_url };
}

/**
 * Process Signus webhook — called when each signatory completes.
 * Downloads signed version, archives it, sends email to owner.
 */
async function processWebhook(payload, rawBody, signature) {
  // Verify HMAC signature from Signus
  if (config.signus.webhookSecret) {
    const expected = crypto
      .createHmac('sha256', config.signus.webhookSecret)
      .update(rawBody)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(expected))) {
      throw new Error('Invalid Signus webhook signature');
    }
  }

  const { event_type, envelope_id, signatory, signed_document_url } = payload;
  logger.info('Signus webhook received', { event_type, envelope_id });

  if (!['signatory.completed', 'envelope.completed'].includes(event_type)) {
    return { ignored: true };
  }

  // Find document by envelope_id
  const { rows } = await db.query(
    `SELECT d.*, u.email AS owner_email, u.first_name || ' ' || u.last_name AS owner_name
     FROM documents d
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.signus_envelope_id = $1 AND d.deleted_at IS NULL`,
    [envelope_id]
  );
  if (!rows.length) {
    logger.warn('Signus webhook: document not found for envelope', { envelope_id });
    return { ignored: true };
  }
  const doc = rows[0];

  // Download signed PDF from Signus URL
  const response = await axios.get(signed_document_url, { responseType: 'arraybuffer', timeout: 60000 });
  const buffer   = Buffer.from(response.data);

  // Determine next version number
  const { rows: vRows } = await db.query(
    'SELECT COALESCE(MAX(version_number), 0) AS max_v FROM document_versions WHERE document_id = $1',
    [doc.id]
  );
  const nextVersion = parseInt(vRows[0].max_v) + 1;

  await db.transaction(async (txClient) => {
    // Upload to Blob Storage
    const blobResult = await storage.uploadDocument(
      buffer,
      `${doc.doc_number}_signed_v${nextVersion}.pdf`,
      'application/pdf',
      doc.id,
      nextVersion
    );

    // Archive as document version
    await txClient.query(
      `INSERT INTO document_versions
         (document_id, version_number, label, blob_path, blob_name, blob_size_bytes, mime_type,
          is_signed, signatory_name, signatory_email, signus_signature_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10)`,
      [
        doc.id,
        nextVersion,
        `Signed by ${signatory?.full_name || signatory?.email}`,
        blobResult.blobPath,
        blobResult.blobName,
        blobResult.blobSizeBytes,
        'application/pdf',
        signatory?.full_name  || null,
        signatory?.email      || null,
        signatory?.signature_id || null,
      ]
    );

    // If all signatories done — mark as signed
    if (event_type === 'envelope.completed') {
      await txClient.query(
        `UPDATE documents
         SET status = 'signed'::doc_status,
             signing_date = CURRENT_DATE,
             blob_path = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [blobResult.blobPath, doc.id]
      );
    }

    // Audit
    await audit.log({
      document: { id: doc.id, doc_number: doc.doc_number, name: doc.name },
      action:   event_type === 'envelope.completed' ? 'signing_completed' : 'signing_completed',
      afterState: { version: nextVersion, signatory: signatory?.email },
      metadata:   { envelope_id, event_type },
      client:     txClient,
    });
  });

  // Email notification to document owner
  if (doc.owner_email) {
    await email.sendSigningNotification({
      to:              doc.owner_email,
      ownerName:       doc.owner_name,
      signatoryName:   signatory?.full_name  || signatory?.email,
      signatoryEmail:  signatory?.email      || '',
      document: { id: doc.id, docNumber: doc.doc_number, name: doc.name },
    });
  }

  return { processed: true, documentId: doc.id };
}

module.exports = { initiateSign, processWebhook };
