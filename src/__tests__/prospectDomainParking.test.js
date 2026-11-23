'use strict';

// A domain-for-sale page answers HTTP 200 with real-looking text, so it must be
// recognised by its wording — otherwise it reaches the identity check as if it
// were the company's site and the company ends up "needs_review" instead of "no_website".

const { isDomainParkingPage } = require('../services/prospectEnrichmentService');

describe('isDomainParkingPage', () => {
  test.each([
    '<title>Oferta domeny instalchem.pl</title><h1>Domena instalchem.pl</h1>',
    '<title>Sprzedam domene www.EXPOL.pl proponowana cena</title>',
    '<title>Sprzedam domenę firma.pl</title>',
    '<p>Ta domena jest na sprzedaż</p>',
    '<h1>This domain is for sale</h1>',
  ])('recognises a domain-for-sale page: %s', (html) => {
    expect(isDomainParkingPage(html)).toBe(true);
  });

  test.each([
    '<h1>Nasza oferta domeny i hosting dla firm</h1>',
    '<p>Oferta: domeny, serwery, poczta</p>',
    '<title>Firma X – producent okien</title>',
    '',
  ])('leaves an ordinary company page alone: %s', (html) => {
    expect(isDomainParkingPage(html)).toBe(false);
  });
});
