'use strict';
// utils/slugify.js — shared kebab-case ASCII slug helper, used by both SEO
// article slugs (seoContentService) and content pillar hub slugs
// (seoStrategyService) so the two don't drift into subtly different rules.

function slugify(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ensureValidSlug(slug, fallbackTitle, fallbackPrefix = 'artykul') {
  if (slug && /^[a-z0-9-]+$/.test(slug)) return slug;
  return slugify(fallbackTitle) || `${fallbackPrefix}-${Date.now()}`;
}

module.exports = { slugify, ensureValidSlug };
