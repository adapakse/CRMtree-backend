'use strict';
// ─────────────────────────────────────────────────────────────────
// utils/seoMarkdown.js — converts the small, fixed markdown subset
// seoContentService.renderBody() produces (## / ### headings, "- " lists,
// **bold**, [text](url) links) into HTML for destinations that need real
// HTML rather than markdown — currently just the WordPress connector.
// Mirrors crmtree-frontend's blog-detail.component.ts renderer; keep the
// two in sync if the markdown subset ever changes.
//
// KNOWN LIMITATION: internal links are generated as [text](/blog/slug) —
// a CRMtree-blog-specific convention. On a client's WordPress site that
// path resolves nowhere (WP's own permalink structure is different and
// unknown ahead of publish time). Left as-is for now rather than building
// cross-CMS link rewriting; the link text still reads fine, it just won't
// be clickable-correct on WordPress.
// ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((\/[^)\s]*|https:\/\/[^)\s]*)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
  return out;
}

function renderBodyHtml(body) {
  return body
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (trimmed.startsWith('### ')) return `<h3>${renderInline(trimmed.slice(4))}</h3>`;
      if (trimmed.startsWith('## ')) return `<h2>${renderInline(trimmed.slice(3))}</h2>`;
      const lines = trimmed.split('\n');
      if (lines.length && lines.every((l) => l.startsWith('- '))) {
        return `<ul>${lines.map((l) => `<li>${renderInline(l.slice(2))}</li>`).join('')}</ul>`;
      }
      return `<p>${renderInline(trimmed)}</p>`;
    })
    .join('\n');
}

module.exports = { renderBodyHtml };
