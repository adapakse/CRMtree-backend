'use strict';
// ─────────────────────────────────────────────────────────────────
// NARZĘDZIE DIAGNOSTYCZNE — nie część scoringu, branch experiment/prospekty-icp-signals
//
// Cel (decyzja Kacpra, 19.08.2026): zamiast zgadywać, które podstrony warto
// crawlować (jak przy poprawce Regulaminu tego samego dnia), zrobić
// systematyczny przegląd — wyciągnąć PEŁNE menu nawigacyjne z próbki
// realnych firm i sprawdzić, jakich częstych etykiet ("Nasi klienci",
// "Zespół", "O firmie"...) obecny LINK_SCORES w ogóle nie rozpoznaje jako
// wartościowe, mimo że tam prawdopodobnie jest treść przydatna do sygnałów.
//
// Nie woła AI — to czyste zbieranie i agregacja danych z linków, tanie.
//
// Użycie:
//   node src/services/menuAuditTool.js [liczbaFirm] [offset]
// ─────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { parse } = require('csv-parse/sync');
const { findWebsiteUrl, fetchPage, extractInternalLinks, scoreLinkRelevance } = require('./prospectEnrichmentService');

const CSV_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  'Downloads',
  'workend_ola_9001-10000.csv'
);

function loadSample(rows, n, offset) {
  const step = Math.max(1, Math.floor(rows.length / n));
  const sample = [];
  for (let i = offset % step; i < rows.length && sample.length < n; i += step) sample.push(rows[i]);
  return sample;
}

async function auditOne(name, websiteHint) {
  const { url } = await findWebsiteUrl(name, websiteHint || null);
  if (!url) return null;
  let html;
  try {
    const page = await fetchPage(url);
    html = page.html;
  } catch { return null; }
  if (!html) return null;

  const $ = cheerio.load(html);
  const hostname = new URL(url).hostname;
  const links = extractInternalLinks($, hostname);

  const unrecognized = [];
  for (const link of links) {
    const score = scoreLinkRelevance(link.path, link.anchor);
    if (score <= 0 && link.anchor && link.anchor.length >= 2 && link.anchor.length <= 40) {
      unrecognized.push(link.anchor);
    }
  }
  return { company: name, url, totalLinks: links.length, unrecognizedAnchors: unrecognized };
}

async function main() {
  const n = parseInt(process.argv[2], 10) || 40;
  const offset = parseInt(process.argv[3], 10) || 0;

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const csvRows = parse(raw, { delimiter: ';', columns: true, skip_empty_lines: true, bom: true });
  const sample = loadSample(csvRows, n, offset);

  console.log(`Audyt menu na ${sample.length} firmach...\n`);
  const freq = new Map(); // znormalizowana etykieta -> liczba wystapien
  let processed = 0, failed = 0;

  for (let i = 0; i < sample.length; i++) {
    const row = sample[i];
    const name = row['Nazwa'];
    const websiteHint = (row['WWW'] || '').trim() || null;
    process.stdout.write(`[${i + 1}/${sample.length}] ${name}... `);
    let result;
    try {
      result = await auditOne(name, websiteHint);
    } catch (e) {
      result = null;
    }
    if (!result) { failed++; console.log('pominięto (brak strony/błąd)'); continue; }
    processed++;
    console.log(`${result.totalLinks} linków, ${result.unrecognizedAnchors.length} nierozpoznanych`);
    for (const anchor of result.unrecognizedAnchors) {
      const norm = anchor.toLowerCase().trim();
      if (!norm) continue;
      freq.set(norm, (freq.get(norm) || 0) + 1);
    }
  }

  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  console.log(`\n=== PODSUMOWANIE (${processed} firm przetworzonych, ${failed} pominiętych) ===`);
  console.log('Najczęstsze etykiety menu, których LINK_SCORES dziś NIE rozpoznaje:\n');
  ranked.forEach(([label, count]) => console.log(`  ${count}x  "${label}"`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
