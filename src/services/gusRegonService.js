'use strict';
/**
 * GUS REGON BIR1.1 — lookup podmiotów
 * Dokumentacja: https://api.stat.gov.pl/Home/RegonApi
 *
 * UWAGA: BIR1.1 nie obsługuje wyszukiwania po nazwie (tylko NIP/REGON/KRS).
 * Klucz API przechowuj w .env jako GUS_REGON_KEY.
 */

const https  = require('https');
const logger = require('../utils/logger');

const HOST     = 'wyszukiwarkaregon.stat.gov.pl';
const PATH     = '/wsBIR/UslugaBIRzewnPubl.svc';
const GUS_KEY  = process.env.GUS_REGON_KEY || 'b440f33e020e4271ab78';

// Poprawne namespace'y wg WSDL UslugaBIRzewnPubl-ver11-prod.wsdl
const NS_BODY  = 'http://CIS/BIR/PUBL/2014/07';              // namespace elementów body
const NS_ACT   = `${NS_BODY}/IUslugaBIRzewnPubl`;            // base URL akcji SOAP
const NS_DAT   = `${NS_BODY}/DataContract`;                   // namespace parametrów wyszukiwania
const NS_WSA   = 'http://www.w3.org/2005/08/addressing';
const NS_SOAP  = 'http://www.w3.org/2003/05/soap-envelope';  // SOAP 1.2

// Sesja trwa 60 min nieaktywności — odnawiamy z 5-minutowym zapasem
let _session = null; // { sid, expires }

// ── SOAP transport ────────────────────────────────────────────────

function soapPost(action, bodyXml, sid) {
  const envelope = Buffer.from([
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:ns="${NS_BODY}" xmlns:dat="${NS_DAT}">`,
    `  <soap:Header>`,
    `    <wsa:To xmlns:wsa="${NS_WSA}" soap:mustUnderstand="1">https://${HOST}${PATH}</wsa:To>`,
    `    <wsa:Action xmlns:wsa="${NS_WSA}" soap:mustUnderstand="1">${NS_ACT}/${action}</wsa:Action>`,
    `  </soap:Header>`,
    `  <soap:Body>${bodyXml}</soap:Body>`,
    `</soap:Envelope>`,
  ].join('\n'), 'utf8');

  const headers = {
    'Content-Type': `application/soap+xml;charset=UTF-8;action="${NS_ACT}/${action}"`,
    'Content-Length': envelope.length,
  };
  if (sid) headers['sid'] = sid;

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, path: PATH, method: 'POST', headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      // GUS/WCF zwraca MTOM (multipart/related) — wyciągamy SOAP Envelope
      res.on('end', () => resolve(extractEnvelope(raw)));
    });
    req.setTimeout(15000, () => req.destroy(new Error('GUS timeout')));
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

// ── XML helpers ───────────────────────────────────────────────────

function extractEnvelope(raw) {
  const m = raw.match(/<[a-zA-Z0-9]+:Envelope[\s\S]*<\/[a-zA-Z0-9]+:Envelope>/);
  return m ? m[0] : raw;
}

function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function htmlDecode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ── Session management ────────────────────────────────────────────

async function ensureSession() {
  const now = Date.now();
  if (_session && now < _session.expires) return _session.sid;

  const xml = await soapPost(
    'Zaloguj',
    `<ns:Zaloguj><ns:pKluczUzytkownika>${GUS_KEY}</ns:pKluczUzytkownika></ns:Zaloguj>`,
    null,
  );
  const sid = xmlVal(xml, 'ZalogujResult');
  if (!sid) {
    logger.error('GUS Zaloguj failed', { xmlSnippet: xml.slice(0, 500) });
    throw new Error('GUS login — brak SID w odpowiedzi');
  }
  _session = { sid, expires: now + 55 * 60 * 1000 };
  logger.debug('GUS session ok', { sid: sid.slice(0, 6) + '...' });
  return sid;
}

function invalidateSession() { _session = null; }

// ── Internal search helper ────────────────────────────────────────

async function daneSzukaj(paramXml, retry = true) {
  const sid = await ensureSession();
  const bodyXml = `<ns:DaneSzukajPodmioty>
    <ns:pParametryWyszukiwania>${paramXml}</ns:pParametryWyszukiwania>
  </ns:DaneSzukajPodmioty>`;

  const xml = await soapPost('DaneSzukajPodmioty', bodyXml, sid);
  const m = xml.match(/<DaneSzukajPodmiotyResult[^>]*>([\s\S]*?)<\/DaneSzukajPodmiotyResult>/i);

  if (!m) {
    logger.warn('GUS — brak elementu DaneSzukajPodmiotyResult', { xmlSnippet: xml.slice(0, 500) });
    if (retry) { invalidateSession(); return daneSzukaj(paramXml, false); }
    return [];
  }

  const inner = htmlDecode(m[1]).trim();
  if (!inner || inner === '0') return [];

  const results = [];
  const re = /<dane>([\s\S]*?)<\/dane>/gi;
  let match;
  while ((match = re.exec(inner)) !== null && results.length < 10) {
    results.push({
      nip:      xmlVal(match[1], 'Nip'),
      regon:    xmlVal(match[1], 'Regon'),
      name:     xmlVal(match[1], 'Nazwa'),
      type:     xmlVal(match[1], 'Typ'),  // P=osoba prawna, F=osoba fizyczna, LP/LF=jednostka lokalna
      // Adres rejestrowy — dostępny w odpowiedzi BIR1.1, wcześniej nie
      // wyciągany (decyzja 20.08: KRS API (ms.gov.pl) jest w praktyce
      // niedostępne — findKrsNumberByNip to no-op, legacy endpoint zwraca
      // 400 — więc to jedyne realnie działające źródło twardego adresu
      // rejestrowego do weryfikacji tożsamości domeny).
      city:     xmlVal(match[1], 'Miejscowosc'),
      postcode: xmlVal(match[1], 'KodPocztowy'),
      street:   xmlVal(match[1], 'Ulica').replace(/^(ul\.|al\.|pl\.)\s*/i, '').trim(),
    });
  }
  return results;
}

// ── DanePobierzPelnyRaport ────────────────────────────────────────

async function danePobierz(regon9, reportName, retry = true) {
  const sid = await ensureSession();
  const bodyXml = `<ns:DanePobierzPelnyRaport>
    <ns:pRegon>${regon9}</ns:pRegon>
    <ns:pNazwaRaportu>${reportName}</ns:pNazwaRaportu>
  </ns:DanePobierzPelnyRaport>`;

  const xml = await soapPost('DanePobierzPelnyRaport', bodyXml, sid);
  const m = xml.match(/<DanePobierzPelnyRaportResult[^>]*>([\s\S]*?)<\/DanePobierzPelnyRaportResult>/i);

  if (!m) {
    logger.warn('GUS — brak DanePobierzPelnyRaportResult', { regon9, reportName, xmlSnippet: xml.slice(0, 300) });
    if (retry) { invalidateSession(); return danePobierz(regon9, reportName, false); }
    return '';
  }

  return htmlDecode(m[1]).trim();
}

function parsePkdCodes(innerXml) {
  const codes = [];
  const re = /<dane>([\s\S]*?)<\/dane>/gi;
  let match;
  while ((match = re.exec(innerXml)) !== null && codes.length < 20) {
    const b = match[1];
    // BIR1.1 używa prefiksu zależnego od typu podmiotu:
    //   praw_pkdKod — osoba prawna (sp. z o.o., S.A. itp.)
    //   fiz_pkdKod  — osoba fizyczna (CEIDG)
    // Fallback: pkdKod / Kod (starsze wersje API lub inne typy raportów)
    const kod   = xmlVal(b, 'praw_pkdKod')         || xmlVal(b, 'fiz_pkdKod')         || xmlVal(b, 'pkdKod')         || xmlVal(b, 'Kod');
    const nazwa = xmlVal(b, 'praw_pkdNazwa')        || xmlVal(b, 'fiz_pkdNazwa')        || xmlVal(b, 'pkdNazwa')        || xmlVal(b, 'Nazwa');
    const prev  = xmlVal(b, 'praw_pkdPrzewazajace') || xmlVal(b, 'fiz_pkdPrzewazajace') || xmlVal(b, 'pkdPrzewazajace') || xmlVal(b, 'Przewazajace');
    if (kod) codes.push({ kod, nazwa, primary: prev === '1' || prev === 'true' });
  }
  return codes;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Lookup po NIP — zwraca { nip, regon, name, type } lub null.
 */
async function lookupByNip(nip) {
  const clean = String(nip).replace(/\D/g, '');
  if (clean.length !== 10) return null;
  const results = await daneSzukaj(`<dat:Nip>${clean}</dat:Nip>`);
  return results[0] || null;
}

/**
 * Pełne dane firmy po NIP — basic lookup + kody PKD.
 * Zwraca { nip, regon, officialName, entityType, pkdCodes, pkdMain } lub null.
 */
async function getCompanyData(nip) {
  const clean = String(nip).replace(/\D/g, '');
  if (clean.length !== 10) return null;

  const basic = await lookupByNip(clean);
  if (!basic?.regon) return null;

  const regon9 = basic.regon.slice(0, 9);
  const isLegal = !basic.type || basic.type === 'P' || basic.type === 'LP';
  const reportName = isLegal ? 'BIR11OsPrawnaPkd' : 'BIR11OsFizycznaCeidgPkd';

  let pkdCodes = [];
  try {
    const pkdXml = await danePobierz(regon9, reportName);
    if (pkdXml) pkdCodes = parsePkdCodes(pkdXml);
  } catch (err) {
    logger.warn('GUS PKD lookup failed', { nip: clean, regon9, err: err.message });
  }

  const pkdMain = pkdCodes.find(c => c.primary)?.kod || pkdCodes[0]?.kod || null;

  logger.info('GUS company data', { nip: clean, regon: basic.regon, pkdCount: pkdCodes.length, pkdMain });
  return {
    nip:          clean,
    regon:        basic.regon,
    city:         basic.city     || null,
    postcode:     basic.postcode || null,
    street:       basic.street   || null,
    officialName: basic.name,
    entityType:   basic.type,
    pkdCodes,
    pkdMain,
  };
}

/**
 * Wyszukiwanie po nazwie firmy — GUS BIR1.1 DaneSzukajPodmioty z parametrem Nazwa.
 * Zwraca tablicę { nip, regon, name, type }, max 10 wyników.
 */
async function searchByName(name) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 3) return [];
  const escaped = trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return daneSzukaj(`<dat:Nazwa>${escaped}</dat:Nazwa>`);
}

module.exports = { lookupByNip, getCompanyData, searchByName };
