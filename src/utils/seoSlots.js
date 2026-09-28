'use strict';
// ─────────────────────────────────────────────────────────────────
// utils/seoSlots.js — "enrichment slots": places in a generated article that
// a human SEO editor fills before approval (Adam, 2026-09-28, after an
// expert review said the articles lacked first-hand commentary, attributed
// quotes and product screenshots — none of which a model can honestly make
// up). The article body holds one [[SLOT:<id>]] marker line per open slot;
// seo_content_pieces.enrichment_slots holds what each slot asks for.
// Filling a slot replaces its marker with plain markdown (blockquote or
// image), so the renderers never need to know slots exist. Approval is
// blocked while any marker remains — the editor fills or removes each one.
// ─────────────────────────────────────────────────────────────────

const SLOT_TYPES = ['expert_comment', 'quote', 'screenshot'];

// Per-article counts Adam picked (2026-09-28): enough to make the article
// specific without turning review into an hour of work per article.
const SLOT_LIMITS = {
  expert_comment: { min: 1, max: 1 },
  quote: { min: 1, max: 2 },
  screenshot: { min: 1, max: 3 },
};

const MARKER_REGEX = /^\[\[SLOT:([a-z0-9_-]+)\]\]$/gim;

function markerFor(id) {
  return `[[SLOT:${id}]]`;
}

function openSlotIds(text) {
  return [...(text || '').matchAll(MARKER_REGEX)].map((m) => m[1]);
}

function screenshotUrl(screenshotId) {
  return `/api/public/blog/screenshots/${screenshotId}`;
}

// Filled values come from the editor's form — one line of plain text each,
// so a stray newline can't break out of the blockquote/image line.
function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\[\[SLOT:/gi, '').trim();
}

function renderSlotMarkdown(type, value) {
  if (type === 'expert_comment') {
    const role = oneLine(value.author_role);
    return `> ${oneLine(value.text)}\n>\n> — **${oneLine(value.author_name)}**${role ? `, ${role}` : ''}`;
  }
  if (type === 'quote') {
    const role = oneLine(value.author_role);
    const source = value.source_url
      ? `[${oneLine(value.source_title) || value.source_url}](${value.source_url})`
      : oneLine(value.source_title);
    const attribution = [`**${oneLine(value.author)}**${role ? `, ${role}` : ''}`, source].filter(Boolean).join(' · ');
    return `> „${oneLine(value.text)}”\n>\n> — ${attribution}`;
  }
  if (type === 'screenshot') {
    return `![${oneLine(value.caption).replace(/[[\]]/g, '')}](${screenshotUrl(value.screenshot_id)})`;
  }
  throw new Error(`Unknown slot type: ${type}`);
}

/** Replaces the slot's marker line with `markdown` (or drops it when markdown is empty). */
function replaceMarker(body, id, markdown) {
  const marker = markerFor(id);
  const lines = body.split('\n');
  const index = lines.findIndex((l) => l.trim() === marker);
  if (index === -1) return null;
  if (markdown) {
    lines.splice(index, 1, '', markdown, '');
  } else {
    lines.splice(index, 1);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = {
  SLOT_TYPES,
  SLOT_LIMITS,
  markerFor,
  openSlotIds,
  screenshotUrl,
  renderSlotMarkdown,
  replaceMarker,
};
