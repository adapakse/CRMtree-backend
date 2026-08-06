"use strict";
// src/utils/emailQuote.js
//
// Shared "new content vs. quoted history" splitter for received/sent email
// bodies — used identically by gmailService, outlookService and zohoService
// so the marker-detection and edge-trimming rules live in ONE place instead
// of drifting across three independent copies. Each provider passes only its
// own small, structural pre-removal hook when its format genuinely needs
// one (Outlook: OWA #divRplyFwdMsg / Desktop border-top reply header; Zoho:
// its "Sent using Zoho Mail" footer) — Gmail needs none beyond the common
// blockquote/.gmail_quote/.gmail_attr removal every provider already shares.

const { load: cheerioLoad } = require("cheerio");

// Removes empty leaf nodes (whitespace-only text, bare <br>, or empty blocks
// like <div><br></div>) from the very start and end of $el's children only —
// stops at the first node with real content on each side, so intentional
// blank lines left in the middle of a message are never touched. Cleans up
// the dangling <br>/empty <div> any provider can leave behind once its own
// quote wrapper has been removed.
function trimEdgeEmptyNodes($, $el) {
  const isEmptyNode = (node) => {
    if (node.type === "text") return !(node.data || "").trim();
    if (node.type !== "tag") return false;
    if (node.name === "br") return true;
    const $node = $(node);
    const hasMedia = $node.find("img,video,audio,iframe,table,hr").length > 0;
    return !hasMedia && !$node.text().trim();
  };

  const trimFrom = (fromStart) => {
    let nodes = $el.contents().toArray();
    if (!fromStart) nodes = nodes.reverse();
    for (const node of nodes) {
      if (!isEmptyNode(node)) break;
      $(node).remove();
    }
  };

  trimFrom(true);
  trimFrom(false);
}

// Converts HTML to the visible text a user would read, replacing block-level
// and line-break elements with newlines. Used only for separator detection —
// never for rendering.
function htmlToVisibleText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(div|p|li|blockquote|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Returns the index in `text` where quoted/older content starts, or -1.
// Covers every citation style seen across the three providers' native
// clients, plus this CRM's own "reply with history" composer:
//   "On [weekday] ... wrote"        — Gmail/Zoho inline citation
//   "[weekday], ... napisał(a):"    — Polish Gmail attribution
//   "----- Original Message -----"  — Outlook plain-text reply
//   "Od: ... Do: ... Temat: ..."    — Outlook/Zoho quoted-message header block
//   "Historia korespondencji"       — this CRM's own reply-with-history divider
//     (crm-lead-detail.component.ts / crm-partner-detail.component.ts buildQuotedBody())
function findQuoteSeparatorIndex(text) {
  const candidates = [];

  const onM = /(-{4,}[\s]*)?\bOn\s+(Mon,?|Tue,?|Wed,?|Thu,?|Fri,?|Sat,?|Sun,?|pon\.|wt\.|śr\.|czw\.|pt\.|sob\.|nd\.)/i.exec(text);
  if (onM && onM.index > 0) candidates.push(onM.index);

  const napM = /napisał\(a\)\s*:/i.exec(text);
  if (napM && napM.index > 0) {
    const nlBefore = text.lastIndexOf("\n", napM.index - 1);
    candidates.push(nlBefore >= 0 ? nlBefore : napM.index);
  }

  const omM = /-{4,}\s*Original Message\s*-{4,}/i.exec(text);
  if (omM && omM.index > 0) candidates.push(omM.index);

  const odM = /^[ \t]*Od:.*$/im.exec(text);
  if (odM && odM.index > 0) {
    const rest = text.slice(odM.index);
    if (/^[ \t]*Do:.*$/im.test(rest) && /^[ \t]*Temat:.*$/im.test(rest)) {
      candidates.push(odM.index);
    }
  }

  const crmM = /^[ \t]*Historia korespondencji[ \t]*$/im.exec(text);
  if (crmM && crmM.index > 0) candidates.push(crmM.index);

  return candidates.length ? Math.min(...candidates) : -1;
}

function toQuoteHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// Splits `html` into { cleanBody, quotedBody }. `quotedBody` is the older
// correspondence to show behind a "show quoted history" toggle, or null when
// there is none — never lost, only reorganized: every branch either keeps
// the removed part in `quotedBody` or leaves it in `cleanBody` untouched, so
// callers never need to fall back to the raw, undivided body to avoid
// dropping history.
//
// opts.removeExtra($) — optional provider-specific structural pre-removal,
//   run (on the cheerio-loaded document) after the common
//   blockquote/.gmail_quote/.gmail_attr removal, before text-marker
//   detection. Must return the HTML of whatever it removed, so it can be
//   preserved as quotedBody — or null/undefined if it removed pure noise
//   with nothing worth showing (e.g. Zoho's footer line).
// opts.filterVisibleText(text) — optional provider-specific text cleanup
//   (e.g. Zoho's inline "Sent using Zoho Mail" footer) applied to the
//   visible-text view before marker detection.
function split(html, opts = {}) {
  const { removeExtra, filterVisibleText } = opts;
  if (!html) return { cleanBody: html, quotedBody: null };

  if (!html.includes("<")) {
    let text = html;
    let forceLossy = false;
    if (typeof filterVisibleText === "function") {
      const filtered = filterVisibleText(text);
      forceLossy = filtered !== text;
      text = filtered;
    }
    const sep = findQuoteSeparatorIndex(text);
    if (sep > 0) {
      return { cleanBody: text.slice(0, sep).trimEnd(), quotedBody: text.slice(sep).trim() };
    }
    return { cleanBody: forceLossy ? text.trim() : html, quotedBody: null };
  }

  const $ = cheerioLoad(html, { decodeEntities: false });

  // Keep only the outermost matches — real Gmail markup nests a
  // .gmail_attr and a blockquote.gmail_quote inside an outer .gmail_quote
  // wrapper, so all three can match this selector at once. Cloning every
  // match independently would clone the outer wrapper (which already
  // contains the inner ones) and then clone the inner ones again on top,
  // duplicating the same quoted text in quotedBody.
  const $commonQuoteAll = $("blockquote, .gmail_quote, .gmail_attr");
  const $commonQuote = $commonQuoteAll.filter((_, el) =>
    $(el).parentsUntil("body").filter("blockquote, .gmail_quote, .gmail_attr").length === 0
  );
  let extractedQuote = null;
  if ($commonQuote.length) {
    const $wrap = $("<div></div>");
    $commonQuote.each(function () { $wrap.append($(this).clone()); });
    extractedQuote = $wrap.html();
    $commonQuote.remove();
  }

  if (typeof removeExtra === "function") {
    const extra = removeExtra($);
    if (extra) extractedQuote = extractedQuote ? extractedQuote + extra : extra;
  }

  trimEdgeEmptyNodes($, $("body"));
  const cleaned = $("body").html() ?? "";

  // A structural wrapper above only ever removes an element that itself
  // carries blockquote/.gmail_quote/.gmail_attr (or whatever a provider's
  // removeExtra hook targets) — the citation line ("On ... wrote:") that
  // precedes it is often a plain, unclassed sibling (e.g. when CSS classes
  // get stripped in transit and only the bare <blockquote> tag survives), so
  // it is never touched by that step and would otherwise stay in cleanBody.
  // Always run the text-marker pass on whatever is left, so that line still
  // ends up in quotedBody instead of being stranded above the toggle.
  let visText = htmlToVisibleText(cleaned);
  let forceLossy = false;
  if (typeof filterVisibleText === "function") {
    const filtered = filterVisibleText(visText);
    forceLossy = filtered !== visText;
    visText = filtered;
  }

  const sep = findQuoteSeparatorIndex(visText);
  if (sep > 0) {
    const before = visText.slice(0, sep).trimEnd();
    if (before) {
      const after     = visText.slice(sep).trim();
      const afterHtml = after ? toQuoteHtml(after) : null;
      // Document order: the citation line (just matched, "after") always
      // precedes an already-extracted structural quote (e.g. a blockquote),
      // so it goes first when combining the two.
      const quotedBody = extractedQuote
        ? (afterHtml ? afterHtml + extractedQuote : extractedQuote)
        : afterHtml;
      return { cleanBody: toQuoteHtml(before), quotedBody };
    }
    // Nothing precedes the match — don't trust an over-eager separator;
    // fall through to the safe branches below exactly as if none was found.
  }

  if (extractedQuote) {
    return { cleanBody: forceLossy ? toQuoteHtml(visText.trim()) : cleaned, quotedBody: extractedQuote };
  }

  return { cleanBody: forceLossy ? toQuoteHtml(visText.trim()) : cleaned, quotedBody: null };
}

module.exports = { trimEdgeEmptyNodes, htmlToVisibleText, findQuoteSeparatorIndex, split };
