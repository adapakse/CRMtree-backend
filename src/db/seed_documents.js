/**
 * Seed script: 30 test documents with 2 attachments each (PDF + DOCX stub).
 * Uploads real PDF files to Azurite local blob storage.
 *
 * Prerequisites:
 *   - Azurite running:  npm run azurite
 *   - Container exists: created automatically on first run
 *
 * Run: node src/db/seed_documents.js
 * Re-run safe: deletes DOC-SEED-* documents first.
 */

require("dotenv").config();
require("dotenv").config({
  path: require("path").resolve(process.cwd(), ".env.local"),
  override: true,
});

const { Pool } = require("pg");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const PDFDocument = require("pdfkit");

// ─── DB + Storage clients ─────────────────────────────────────────────────────

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "crmtree",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const CONTAINER = process.env.AZURE_STORAGE_CONTAINER || "documents";
const blobService = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING || "UseDevelopmentStorage=true"
);

// ─── PDF generation ───────────────────────────────────────────────────────────

const LOREM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante. Donec eu libero sit amet quam egestas semper. Aenean ultricies mi vitae est. Mauris placerat eleifend leo.

Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae, ornare sit amet, wisi. Aenean fermentum, elit eget tincidunt condimentum, eros ipsum rutrum orci, sagittis tempus lacus enim ac dui. Donec non enim in turpis pulvinar facilisis.

Ut lectus eros, malesuada sit amet, fermentum eu, sodales cursus, magna. Donec eu purus. Quisque vehicula, urna sed ultricies auctor, pede lorem egestas dui, et convallis elit erat sed nulla. Donec luctus. Curabitur et nunc. Aliquam dolor odio, commodo pretium, ultricies non, pharetra in, velit. Integer arcu est, nonummy in, fermentum faucibus, egestas vel, odio.`;

function generateContractPdf(title, parties, subject, docNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const today = new Date().toLocaleDateString("pl-PL", {
      day: "2-digit", month: "long", year: "numeric",
    });

    doc.fontSize(16).font("Helvetica-Bold").text("UMOWA HANDLOWA", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(11).font("Helvetica").text(`Nr dokumentu: ${docNumber}`, { align: "center" });
    doc.moveDown(0.3);
    doc.text(`Data: ${today}`, { align: "center" });
    doc.moveDown(1.5);

    doc.fontSize(13).font("Helvetica-Bold").text(title, { align: "center" });
    doc.moveDown(1);

    doc.fontSize(10).font("Helvetica-Bold").text("§ 1. Strony umowy");
    doc.font("Helvetica").fontSize(10).moveDown(0.4);
    parties.forEach((p, i) =>
      doc.text(`${i + 1}. ${p}`)
    );
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text("§ 2. Przedmiot umowy");
    doc.font("Helvetica").fontSize(10).moveDown(0.4);
    doc.text(`Przedmiotem niniejszej umowy jest: ${subject}.`);
    doc.moveDown(0.6);
    doc.text(LOREM, { align: "justify" });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text("§ 3. Warunki realizacji");
    doc.font("Helvetica").fontSize(10).moveDown(0.4);
    doc.text(
      "Strony zobowiązują się do realizacji niniejszej umowy zgodnie z obowiązującymi " +
      "przepisami prawa oraz dobrymi praktykami branżowymi. Wszelkie zmiany wymagają " +
      "formy pisemnej pod rygorem nieważności.",
      { align: "justify" }
    );
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text("§ 4. Postanowienia końcowe");
    doc.font("Helvetica").fontSize(10).moveDown(0.4);
    doc.text(
      "Umowa wchodzi w życie z dniem podpisania przez obie strony. W sprawach " +
      "nieuregulowanych niniejszą umową stosuje się przepisy Kodeksu Cywilnego.",
      { align: "justify" }
    );
    doc.moveDown(2);

    doc.font("Helvetica-Bold").text("Podpisy stron:", { align: "left" });
    doc.moveDown(2);
    doc.font("Helvetica").text("_________________________          _________________________");
    doc.text(parties[0] || "Strona 1");

    doc.end();
  });
}

function generateDocxStub(title, docNumber) {
  // Minimal valid DOCX is complex; generate a plain-text stub that looks like a spec.
  const content = `Specyfikacja techniczna — Załącznik nr 1\nDokument: ${docNumber}\nTytuł: ${title}\n\n${LOREM}\n\nData sporządzenia: ${new Date().toLocaleDateString("pl-PL")}`;
  return Buffer.from(content, "utf-8");
}

// ─── Seed data ────────────────────────────────────────────────────────────────

const DOC_TYPES = [
  "partner_agreement",
  "it_supplier_agreement",
  "employee_agreement",
  "nda",
  "operator_agreement",
];

const DOC_STATUSES = ["new", "being_edited", "signed", "completed", "hold"];

const COMPANIES = [
  "TechSoft Sp. z o.o.",
  "GlobalLogic S.A.",
  "BizPartner Sp. z o.o.",
  "InnoVate Technologies",
  "DataCore Polska Sp. z o.o.",
  "CloudSystems S.A.",
  "FlexWork Sp. z o.o.",
  "MediTech Solutions",
  "EcoGreen Sp. z o.o.",
  "SmartBuild S.A.",
  "DigitalWave Sp. z o.o.",
  "ProConsult Group",
  "AgileSoft Sp. z o.o.",
  "CyberSec Poland S.A.",
  "LogiTrans Sp. z o.o.",
];

const CONTRACT_SUBJECTS = [
  "Wdrożenie systemu ERP",
  "Dostawa oprogramowania CRM",
  "Usługi hostingowe i utrzymanie",
  "Outsourcing IT",
  "Licencja na oprogramowanie",
  "Usługi consultingowe",
  "Dostawa sprzętu IT",
  "Usługi SaaS",
  "Wsparcie techniczne",
  "Integracja systemów",
  "Audyt bezpieczeństwa",
  "Szkolenia pracownicze",
  "Usługi chmurowe AWS/Azure",
  "Zarządzanie projektem IT",
  "Dostawa infrastruktury sieciowej",
];

const CONTACT_NAMES = [
  "Anna Kowalska", "Piotr Wiśniewski", "Katarzyna Wójcik", "Marek Kowalczyk",
  "Joanna Kamińska", "Tomasz Lewandowski", "Agnieszka Zielińska", "Michał Szymański",
  "Monika Woźniak", "Robert Dąbrowski",
];

const NIPS = [
  "5252345678", "7811234567", "6762345678", "5261234567", "9512345678",
  "5242345678", "5272345678", "7272345678", "5242135678", "8992345678",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ─── Upload helper ────────────────────────────────────────────────────────────

async function uploadBlob(blobPath, buffer, mimeType) {
  const container = blobService.getContainerClient(CONTAINER);
  await container.createIfNotExists();
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });
  return buffer.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();
  try {
    // Fetch existing users
    const { rows: users } = await client.query(
      `SELECT id, email FROM users WHERE is_active = true ORDER BY created_at LIMIT 20`
    );
    if (users.length === 0) {
      console.error("No active users found.");
      process.exit(1);
    }

    // Fetch group_profiles
    const { rows: groups } = await client.query(
      `SELECT id FROM group_profiles WHERE is_active = true`
    );
    const groupIds = groups.length > 0 ? groups.map((g) => g.id) : [null];

    console.log(`Users: ${users.length}  Groups: ${groups.length}`);

    // Delete previous seed run
    const { rowCount: deleted } = await client.query(
      `DELETE FROM documents WHERE doc_number LIKE 'DOC-SEED-%'`
    );
    if (deleted > 0) console.log(`Removed ${deleted} documents from previous seed.`);

    await client.query("BEGIN");

    const year = new Date().getFullYear();
    let seq = 1;
    const inserted = [];

    for (let i = 0; i < 30; i++) {
      const docId = uuidv4();
      const owner = pick(users);
      const creator = pick(users);
      const groupId = pick(groupIds);
      const docType = pick(DOC_TYPES);
      const status = pick(DOC_STATUSES);
      const company = pick(COMPANIES);
      const subject = pick(CONTRACT_SUBJECTS);
      const contactName = pick(CONTACT_NAMES);
      const nip = pick(NIPS);
      const creationDate = addDays(`${year - 1}-09-01`, randInt(0, 240));
      const signingDate = (status === "signed" || status === "completed")
        ? addDays(creationDate, randInt(7, 30))
        : null;
      const expirationDate = signingDate
        ? addDays(signingDate, randInt(180, 730))
        : null;

      const docNum = `DOC-SEED-${year}-${String(seq).padStart(4, "0")}`;
      seq++;

      const title = `${company} — ${subject}`;

      // ── Generate & upload main PDF ──────────────────────────────────────
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${30}] ${docNum} ... `);

      const pdfBuffer = await generateContractPdf(title, [company, "CRMtree Sp. z o.o."], subject, docNum);
      const pdfBlobName = `${docNum.toLowerCase().replace(/-/g, "_")}.pdf`;
      const pdfBlobPath = `documents/${docId}/v1_${uuidv4()}.pdf`;
      const pdfSize = await uploadBlob(pdfBlobPath, pdfBuffer, "application/pdf");

      // ── Insert document row ─────────────────────────────────────────────
      await client.query(
        `INSERT INTO documents (
          id, doc_number, name, doc_type, entities, owner_id,
          group_id, gdpr_type, status, creation_date, signing_date,
          expiration_date, blob_path, blob_name, blob_size_bytes, mime_type,
          nip, country, contract_subject, contact_name, contact_email,
          contact_phone, created_by, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,'no_gdpr',$8,$9,$10,
          $11,$12,$13,$14,'application/pdf',
          $15,'Polska',$16,$17,$18,
          $19,$20,NOW() - ($21 || ' days')::interval,NOW()
        )`,
        [
          docId, docNum, title, docType, [company], owner.id,
          groupId, status, creationDate, signingDate,
          expirationDate, pdfBlobPath, pdfBlobName, pdfSize,
          nip, subject, contactName,
          `${contactName.split(" ")[0].toLowerCase()}@${company.replace(/[^a-z]/gi, "").toLowerCase().slice(0, 10)}.pl`,
          `+48 ${randInt(500, 799)} ${randInt(100, 999)} ${randInt(100, 999)}`,
          creator.id, randInt(1, 180),
        ]
      );

      // ── Attachment 1: copy of main PDF (as attachment record) ───────────
      const att1Id = uuidv4();
      await client.query(
        `INSERT INTO document_attachments
          (id, document_id, name, blob_path, blob_name, blob_size_bytes, mime_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7)`,
        [att1Id, docId, `Treść umowy — ${pdfBlobName}`, pdfBlobPath, pdfBlobName, pdfSize, creator.id]
      );

      // ── Attachment 2: DOCX specification stub ───────────────────────────
      const att2Id = uuidv4();
      const docxBuffer = generateDocxStub(title, docNum);
      const docxBlobName = `zalacznik_${docNum.toLowerCase().replace(/-/g, "_")}.docx`;
      const docxBlobPath = `attachments/${att2Id}/v1_${uuidv4()}.docx`;
      const docxSize = await uploadBlob(
        docxBlobPath, docxBuffer,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );

      await client.query(
        `INSERT INTO document_attachments
          (id, document_id, name, blob_path, blob_name, blob_size_bytes, mime_type, created_by)
         VALUES ($1,$2,'Załącznik nr 1 — Specyfikacja techniczna',$3,$4,$5,
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$6)`,
        [att2Id, docId, docxBlobPath, docxBlobName, docxSize, creator.id]
      );

      process.stdout.write(`OK (PDF ${Math.round(pdfSize / 1024)}KB)\n`);
      inserted.push({ docNum, title, owner: owner.email });
    }

    await client.query("COMMIT");

    console.log(`\n✓ Seeded ${inserted.length} documents into DB + Azurite blob storage.`);
    console.log(`  Container: ${CONTAINER}  |  Blobs: ${inserted.length * 2} (PDF + DOCX each)\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\nSeed failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
