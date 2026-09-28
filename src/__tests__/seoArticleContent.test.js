'use strict';

// SEObot article rendering and validation after the expert review of
// 2026-09-28: numbered lists and mixed blocks rendered as run-on paragraphs,
// and articles gained enrichment slots (utils/seoSlots.js).

const { renderBodyHtml } = require('../utils/seoMarkdown');
const slots = require('../utils/seoSlots');
const { validateArticle, renderBody } = require('../services/seoContentService');

describe('renderBodyHtml', () => {
  it('renders a numbered list as <ol>, not one paragraph', () => {
    const html = renderBodyHtml('1. Zdefiniuj kryteria.\n2. Skonfiguruj CRM.\n3. Przeszkol zespół.');
    expect(html).toBe('<ol><li>Zdefiniuj kryteria.</li><li>Skonfiguruj CRM.</li><li>Przeszkol zespół.</li></ol>');
  });

  it('splits a sentence and the list right under it without a blank line', () => {
    const html = renderBodyHtml('Trzy etapy:\n- surowy\n- MQL\n- SQL');
    expect(html).toBe('<p>Trzy etapy:</p>\n<ul><li>surowy</li><li>MQL</li><li>SQL</li></ul>');
  });

  it('renders a quote with attribution and a captioned image', () => {
    const html = renderBodyHtml('> „Tekst cytatu”\n>\n> — **Jan Nowak**, CEO\n\n![Pipeline w CRMtree](/api/public/blog/screenshots/7)');
    expect(html).toContain('<blockquote><p>„Tekst cytatu”</p><footer>— <strong>Jan Nowak</strong>, CEO</footer></blockquote>');
    expect(html).toContain('<figure><img src="/api/public/blog/screenshots/7" alt="Pipeline w CRMtree" loading="lazy"><figcaption>Pipeline w CRMtree</figcaption></figure>');
  });

  it('never renders an open slot marker and escapes HTML', () => {
    expect(renderBodyHtml('[[SLOT:cytat-1]]\n\n<script>x</script>')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });

  it('does not loop on a pipe line that is not a table', () => {
    expect(renderBodyHtml('| samotna linia')).toBe('<p>| samotna linia</p>');
  });
});

describe('seoSlots', () => {
  const body = 'Akapit.\n\n[[SLOT:komentarz-1]]\n\nDalej.';

  it('finds open markers and replaces one with markdown', () => {
    expect(slots.openSlotIds(body)).toEqual(['komentarz-1']);
    const md = slots.renderSlotMarkdown('expert_comment', { text: 'Z praktyki:\nkrótko.', author_name: 'Anna', author_role: 'Head of Sales' });
    const filled = slots.replaceMarker(body, 'komentarz-1', md);
    expect(filled).toBe('Akapit.\n\n> Z praktyki: krótko.\n>\n> — **Anna**, Head of Sales\n\nDalej.');
    expect(slots.openSlotIds(filled)).toEqual([]);
  });

  it('removes a marker without leaving extra blank lines', () => {
    expect(slots.replaceMarker(body, 'komentarz-1', '')).toBe('Akapit.\n\nDalej.');
  });

  it('returns null when the marker is gone', () => {
    expect(slots.replaceMarker('Bez znaczników.', 'x', '')).toBeNull();
  });

  it('renders a quote with a linked source', () => {
    const md = slots.renderSlotMarkdown('quote', {
      text: 'Cytat', author: 'Komisja Europejska', author_role: null, source_title: 'AI Act', source_url: 'https://eur-lex.europa.eu/x',
    });
    expect(md).toBe('> „Cytat”\n>\n> — **Komisja Europejska** · [AI Act](https://eur-lex.europa.eu/x)');
  });
});

describe('validateArticle', () => {
  const paragraph = (n) => Array.from({ length: n }, (_v, i) => `słowo${i}`).join(' ');
  const baseArticle = () => ({
    title: 'Lead scoring w CRM',
    slug: 'lead-scoring-w-crm',
    meta_title: 'Lead scoring w CRM — jak ustawić progi i kryteria w praktyce',
    meta_description: 'Lead scoring w CRM krok po kroku: kryteria, progi, typowe błędy i to, jak AI ocenia skłonność do zakupu. Praktyczny poradnik dla menedżerów sprzedaży.',
    primary_keyword: 'lead scoring',
    lead: 'Lead scoring to metoda oceny leadów.',
    tldr_bullets: ['a', 'b', 'c', 'd', 'e'],
    sections: [
      { heading: 'Czym jest lead scoring?', level: 'h2', content_markdown: `W CRMtree scoring ICP działa od razu.\n\n1. Krok\n2. Krok\n\n[[SLOT:komentarz-1]]` },
      { heading: 'Dla kogo jest lead scoring', level: 'h2', content_markdown: `- punkt\n- punkt\n\n[[SLOT:cytat-1]]` },
      { heading: 'Dla kogo NIE jest to rozwiązanie', level: 'h2', content_markdown: '[[SLOT:screen-1]]' },
    ],
    faq: [],
    internal_link_suggestions: [],
    enrichment_slots: [
      { id: 'komentarz-1', type: 'expert_comment', brief: 'Jaki próg scoringu sprawdza się w praktyce?', feature_tag: null, screenshot_id: null, quote_index: null },
      { id: 'cytat-1', type: 'quote', brief: 'Cytat z badania o skuteczności scoringu.', feature_tag: null, screenshot_id: null, quote_index: null },
      { id: 'screen-1', type: 'screenshot', brief: 'Lista prospektów posortowana po scoringu ICP.', feature_tag: 'Prospekty', screenshot_id: null, quote_index: null },
    ],
  });
  const errorsOf = (article, opts) => validateArticle(article, 'lead scoring', new Set(), opts).errors;

  it('accepts a complete slot set', () => {
    const errors = errorsOf(baseArticle(), { requireSlots: true, productName: 'CRMtree' });
    expect(errors.filter((e) => /miejsc|SLOT|CRMtree|list|akapit/i.test(e))).toEqual([]);
  });

  it('flags a wall of text and too few lists', () => {
    const article = baseArticle();
    article.sections[0].content_markdown = paragraph(130);
    article.sections[1].content_markdown = 'krótko';
    const errors = errorsOf(article, {});
    expect(errors.some((e) => /akapit dłuższy niż 110/.test(e))).toBe(true);
    expect(errors.some((e) => /Za mało list/.test(e))).toBe(true);
  });

  it('requires the product to be named in the sections', () => {
    const article = baseArticle();
    article.sections[0].content_markdown = article.sections[0].content_markdown.replace('CRMtree', 'system');
    expect(errorsOf(article, { productName: 'CRMtree' }).some((e) => /Nazwa produktu "CRMtree" występuje w sekcjach 0 razy/.test(e))).toBe(true);
  });

  it('flags missing slot types, orphan markers and unknown screenshots', () => {
    const article = baseArticle();
    article.enrichment_slots = article.enrichment_slots.filter((s) => s.type !== 'expert_comment');
    article.enrichment_slots[1].screenshot_id = 99;
    const errors = errorsOf(article, { requireSlots: true });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/typu "expert_comment" jest 0/),
      expect.stringMatching(/\[\[SLOT:komentarz-1\]\] nie ma definicji/),
      expect.stringMatching(/nieistniejący screen \(id 99\)/),
    ]));
  });
});

describe('renderBody', () => {
  it('lists every cited external source once in "Źródła"', () => {
    const body = renderBody({
      lead: 'Lead.',
      tldr_bullets: [],
      sections: [{ heading: 'H', level: 'h2', content_markdown: 'Wg [raportu GUS](https://stat.gov.pl/a) i znowu [GUS](https://stat.gov.pl/a).' }],
      faq: [],
      internal_link_suggestions: [],
    }, null);
    expect(body).toContain('## Źródła\n\n- [raportu GUS](https://stat.gov.pl/a)');
    expect(body.match(/stat\.gov\.pl\/a/g)).toHaveLength(3);
  });
});
