'use strict';

// Poprawka 06.11 (OOM batcha enrichmentu na PROD) — limit pamięci na jedną
// pobraną stronę. Test na prawdziwym lokalnym serwerze HTTP (bez mocka
// axios): za duża strona jest czytana strumieniowo i UCINANA do pierwszych
// MAX_PAGE_BYTES (nie odrzucana — odrzucenie strony głównej = utrata całej
// firmy), zwykła strona przechodzi bez zmian.

// These tests crawl a local HTTP server, which the crawler blocks by default.
process.env.CRAWLER_ALLOW_PRIVATE_NETWORK = 'true';

const http = require('http');
const zlib = require('zlib');
const svc = require('../services/prospectEnrichmentService');

const SMALL_HTML = `<html><head><title>Mała</title><!-- ${'x'.repeat(600)} --></head><body><p>Oferta firmy i kontakt z działem handlowym.</p></body></html>`;
const BIG_HEAD = '<html><head><title>Wodociągi</title></head><body><p>Dział obsługi klienta — kontakt dla firm.</p>';
const BIG_TOTAL = 6 * 1024 * 1024;

let server;
let base;
const hits = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    res.on('error', () => {});
    if (req.url === '/big' || req.url === '/big-gzip') {
      const chunk = Buffer.from('<p>' + 'a'.repeat(64 * 1024) + '</p>');
      const gzip = req.url === '/big-gzip';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      const out = gzip ? zlib.createGzip() : res;
      if (gzip) { out.pipe(res); out.on('error', () => {}); }
      out.write(BIG_HEAD);
      let sent = BIG_HEAD.length;
      const write = () => {
        while (sent < BIG_TOTAL) {
          sent += chunk.length;
          if (!out.write(chunk)) { out.once('drain', write); return; }
        }
        out.end();
      };
      write();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SMALL_HTML);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(r => server.close(r)));

test('limit strony wynosi 5 MB, batch przetwarza 5 firm naraz', () => {
  expect(svc.MAX_PAGE_BYTES).toBe(5 * 1024 * 1024);
  expect(svc.BATCH_CONCURRENCY).toBe(5);
});

test('za duża strona jest ucinana do 5 MB, a jej początek zostaje (bez ponawiania)', async () => {
  const result = await svc.fetchPageResilient(`${base}/big`);
  expect(result.error).toBeUndefined();
  expect(result.html.startsWith(BIG_HEAD)).toBe(true);
  expect(Buffer.byteLength(result.html)).toBe(svc.MAX_PAGE_BYTES);
  expect(hits['/big']).toBe(1);
}, 30_000);

test('limit liczony po dekompresji (gzip)', async () => {
  const result = await svc.fetchPageResilient(`${base}/big-gzip`);
  expect(result.html.startsWith(BIG_HEAD)).toBe(true);
  expect(Buffer.byteLength(result.html)).toBe(svc.MAX_PAGE_BYTES);
}, 30_000);

test('zwykła strona pobiera się bez zmian', async () => {
  const result = await svc.fetchPageResilient(`${base}/small`);
  expect(result.html).toBe(SMALL_HTML);
  expect(result.error).toBeUndefined();
});

test('fetchPage (strona główna) zwraca początek za dużej strony zamiast błędu', async () => {
  const { html } = await svc.fetchPage(`${base}/big`);
  expect(html.startsWith(BIG_HEAD)).toBe(true);
  expect(Buffer.byteLength(html)).toBe(svc.MAX_PAGE_BYTES);
  expect(html).toContain('Dział obsługi klienta — kontakt dla firm.');
});
