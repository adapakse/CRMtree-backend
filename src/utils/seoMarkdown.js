'use strict';
// ─────────────────────────────────────────────────────────────────
// utils/seoMarkdown.js — converts the small, fixed markdown subset SEObot
// articles use (## / ### headings, "- " and "1. " lists, > blockquotes,
// standalone ![caption](src) images, tables, **bold**, [text](url) links)
// into HTML for destinations that need real HTML rather than markdown —
// currently the WordPress connector. Mirrors crmtree-frontend's
// shared/utils/seo-markdown.util.ts renderer; keep the two in sync if the
// markdown subset ever changes.
//
// Parsed line by line, not block by block: numbered lists were not
// supported and the model doesn't always put a blank line before a list,
// so a block-based parser rendered whole lists as one run-on paragraph
// (13 lists in 12 of the first 22 published articles, 2026-09-28).
//
// KNOWN LIMITATION: internal links ([text](/blog/slug)) and screenshots
// (/api/public/blog/screenshots/:id) use CRMtree-blog-relative paths. On a
// client's WordPress site those resolve nowhere. Left as-is for now rather
// than building cross-CMS link rewriting.
// ─────────────────────────────────────────────────────────────────

const SLOT_LINE = /^\[\[SLOT:[a-z0-9_-]+\]\]$/i;
const IMAGE_LINE = /^!\[([^\]]*)\]\((\/[^)\s]*|https:\/\/[^)\s]*)\)$/;
const UNORDERED_ITEM = /^[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\d+[.)]\s+(.*)$/;

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((\/[^)\s]*|https:\/\/[^)\s]*)\)/g, (_m, label, href) => {
    const external = href.startsWith('https://');
    return `<a href="${href}"${external ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  return out;
}

function isTableSeparatorRow(line) {
  return /-/.test(line) && /^\|?[\s:-]+\|[\s:|-]*\|?$/.test(line.trim());
}

function parseTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function startsOtherBlock(line) {
  return !line || SLOT_LINE.test(line) || /^(#{2,3} |>|\|)/.test(line) || IMAGE_LINE.test(line)
    || UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line);
}

// A quote block's last paragraph starting with a dash is the attribution.
function renderBlockquote(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line) { current.push(line); continue; }
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  }
  if (current.length) paragraphs.push(current.join(' '));
  const parts = paragraphs.map((p) =>
    /^[—–-]\s/.test(p) ? `<footer>${renderInline(p)}</footer>` : `<p>${renderInline(p)}</p>`,
  );
  return `<blockquote>${parts.join('')}</blockquote>`;
}

function renderBodyHtml(body) {
  const lines = (body || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || SLOT_LINE.test(line)) { i++; continue; }

    if (line.startsWith('### ')) { html.push(`<h3>${renderInline(line.slice(4))}</h3>`); i++; continue; }
    if (line.startsWith('## ')) { html.push(`<h2>${renderInline(line.slice(3))}</h2>`); i++; continue; }

    const image = line.match(IMAGE_LINE);
    if (image) {
      const caption = image[1].trim();
      const figcaption = caption ? `<figcaption>${renderInline(caption)}</figcaption>` : '';
      html.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(caption)}" loading="lazy">${figcaption}</figure>`);
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, '').trim());
        i++;
      }
      html.push(renderBlockquote(quoteLines));
      continue;
    }

    if (line.startsWith('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const header = parseTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(parseTableRow(lines[i])); i++; }
      html.push(`<table><thead><tr>${header.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`);
      continue;
    }

    const listPattern = UNORDERED_ITEM.test(line) ? UNORDERED_ITEM : ORDERED_ITEM.test(line) ? ORDERED_ITEM : null;
    if (listPattern) {
      const items = [];
      while (i < lines.length && listPattern.test(lines[i])) { items.push(lines[i].match(listPattern)[1]); i++; }
      const tag = listPattern === UNORDERED_ITEM ? 'ul' : 'ol';
      html.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && !startsOtherBlock(lines[i])) { paragraph.push(lines[i]); i++; }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }
  return html.join('\n');
}

module.exports = { renderBodyHtml };
