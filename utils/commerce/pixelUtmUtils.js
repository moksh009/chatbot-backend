'use strict';

function readQueryParam(urlStr, key) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const u = new URL(urlStr);
    const val = u.searchParams.get(key);
    return val ? String(val).trim().slice(0, 256) : null;
  } catch {
    return null;
  }
}

function readReferrerDomain(referrer) {
  if (!referrer || typeof referrer !== 'string') return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '').slice(0, 128);
  } catch {
    return null;
  }
}

/**
 * Extract UTM + referrer from webhook/pixel payload.
 */
function extractUtmFields(data = {}) {
  const url =
    data.url ||
    data.checkoutUrl ||
    data.checkout_url ||
    data.landingUrl ||
    data.landing_url ||
    '';

  const utmSource =
    data.utmSource ||
    data.utm_source ||
    data.metadata?.utm_source ||
    readQueryParam(url, 'utm_source') ||
    null;

  const utmMedium =
    data.utmMedium ||
    data.utm_medium ||
    data.metadata?.utm_medium ||
    readQueryParam(url, 'utm_medium') ||
    null;

  const utmCampaign =
    data.utmCampaign ||
    data.utm_campaign ||
    data.metadata?.utm_campaign ||
    readQueryParam(url, 'utm_campaign') ||
    null;

  const referrerDomain =
    data.referrerDomain ||
    data.referrer_domain ||
    readReferrerDomain(data.referrer || data.referrerUrl || data.referrer_url) ||
    null;

  const out = {};
  if (utmSource) out.utmSource = utmSource;
  if (utmMedium) out.utmMedium = utmMedium;
  if (utmCampaign) out.utmCampaign = utmCampaign;
  if (referrerDomain) out.referrerDomain = referrerDomain;
  return out;
}

module.exports = { extractUtmFields };
