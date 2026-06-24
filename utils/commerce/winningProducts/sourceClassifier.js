'use strict';

const { extractUtmFields } = require('../pixelUtmUtils');

const SOURCE_KEYS = ['direct', 'search', 'social', 'email', 'paid', 'referral', 'internal', 'other'];

const SEARCH_HOSTS = /google\.|bing\.|yahoo\.|duckduckgo\./i;
const SOCIAL_HOSTS = /facebook\.|instagram\.|twitter\.|x\.com|tiktok\.|linkedin\.|pinterest\./i;

function classifyEventSource(metadata = {}, url = '') {
  const utm = extractUtmFields({ ...metadata, url: url || metadata?.url });

  if (utm.utmMedium === 'email') return 'email';
  if (utm.utmMedium === 'cpc' || utm.utmMedium === 'paid_social' || utm.utmMedium === 'ppc') {
    return 'paid';
  }

  const referrer = metadata?.referrer || metadata?.referrerUrl || metadata?.referrer_url || '';
  if (!referrer && !utm.referrerDomain && !utm.utmSource) return 'direct';

  const domain = utm.referrerDomain || '';
  if (domain && SEARCH_HOSTS.test(domain)) return 'search';
  if (domain && SOCIAL_HOSTS.test(domain)) return 'social';
  if (utm.utmSource && SOCIAL_HOSTS.test(utm.utmSource)) return 'social';

  if (referrer) {
    try {
      const host = new URL(referrer).hostname.replace(/^www\./, '');
      if (SEARCH_HOSTS.test(host)) return 'search';
      if (SOCIAL_HOSTS.test(host)) return 'social';
      if (metadata?.shopDomain && host.includes(metadata.shopDomain.replace(/^https?:\/\//, ''))) {
        return 'internal';
      }
      return 'referral';
    } catch {
      return 'other';
    }
  }

  return utm.utmSource ? 'referral' : 'other';
}

function aggregateSourceCounts(events) {
  const counts = Object.fromEntries(SOURCE_KEYS.map((k) => [k, 0]));
  let total = 0;
  for (const ev of events) {
    const src = classifyEventSource(ev.metadata || {}, ev.url);
    counts[src] = (counts[src] || 0) + 1;
    total += 1;
  }
  const breakdown = {};
  for (const key of SOURCE_KEYS) {
    const count = counts[key] || 0;
    if (count <= 0) continue;
    breakdown[key] = {
      count,
      percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  }
  return { total, breakdown };
}

module.exports = {
  SOURCE_KEYS,
  classifyEventSource,
  aggregateSourceCounts,
};
