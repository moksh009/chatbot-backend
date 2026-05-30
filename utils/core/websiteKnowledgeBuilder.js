'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { callAI } = require('./aiGateway');

const UA = 'Mozilla/5.0 (TopEdgeAI KnowledgeBot/1.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

function normalizeOrigin(input) {
  try {
    const u = new URL(String(input || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

function stripHtml(html) {
  if (!html) return '';
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

function formatInr(price) {
  const n = parseFloat(String(price || '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

async function fetchHtml(url, timeout = 12000) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    timeout,
    maxRedirects: 4,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return data;
}

async function fetchShopifyProducts(origin, maxProducts = 120) {
  const products = [];
  let page = 1;
  while (products.length < maxProducts && page <= 5) {
    const url = `${origin}/products.json?limit=250&page=${page}`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeout: 12000,
      validateStatus: (s) => s === 200,
    }).catch(() => ({ data: null }));
    const batch = data?.products || [];
    if (!batch.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
    page += 1;
  }
  return products.slice(0, maxProducts);
}

function parseJsonLd($) {
  const out = { org: null, products: [] };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).html() || '{}');
      const nodes = Array.isArray(raw) ? raw : [raw];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const type = String(node['@type'] || '').toLowerCase();
        if (type.includes('organization') || type.includes('website')) {
          out.org = out.org || node;
        }
        if (type.includes('product')) {
          out.products.push(node);
        }
      }
    } catch (_) {}
  });
  return out;
}

function removeNoise($) {
  $(
    'script, style, noscript, iframe, svg, img, link, meta, nav, header, footer, ' +
    '[role="navigation"], [role="banner"], .cart, #cart, .header, .footer, ' +
    '.announcement-bar, .shopify-section-group-header-group, .shopify-section-group-footer-group, ' +
    '.skip-to-content, #shopify-section-header, #shopify-section-footer'
  ).remove();
}

function extractLines(text, max = 40) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 280)
    .filter((s) => !/^(skip to|log in|cart|search|menu|close|open|view cart|check out)/i.test(s))
    .slice(0, max);
}

function extractContact(text) {
  const src = String(text || '');
  const phones = uniq(
    (src.match(/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g) || [])
      .map((p) => p.replace(/\s+/g, ' ').trim())
  );
  const emails = uniq((src.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []));
  const pinMatch = src.match(/(\d{6})/);
  let address = null;
  const addrMatch = src.match(/(\d+[,\s].{10,120}?(?:Gujarat|Maharashtra|Delhi|Karnataka|Tamil Nadu|India)[^.]{0,40}\d{6})/i);
  if (addrMatch) address = addrMatch[1].replace(/\s+/g, ' ').trim();
  return { phones, emails, address, pincode: pinMatch?.[1] || null };
}

function extractStats(text) {
  const stats = [];
  const src = String(text || '');
  const customerMatch = src.match(/(\d+[Kk]?\+?)\s*Customers?[^.]{0,60}/i);
  if (customerMatch) stats.push(customerMatch[0].replace(/\s+/g, ' ').trim());
  const shareMatch = src.match(/(\d+%)\s*Wireless Doorbell[^.]{0,40}/i);
  if (shareMatch) stats.push(shareMatch[0].replace(/\s+/g, ' ').trim());
  const reviewMatch = src.match(/(\d+\+)\s*Positive Reviews?[^.]{0,40}/i);
  if (reviewMatch) stats.push(reviewMatch[0].replace(/\s+/g, ' ').trim());
  return uniq(stats).slice(0, 6);
}

function extractTestimonials(text) {
  const quotes = [];
  const src = String(text || '');
  const patterns = [
    /[""']([^""']{30,220})[""']\s*[-–—]\s*([A-Za-z .,]{3,50})/g,
    /(From protecting[^.]{10,200}\.)\s*[-–—]?\s*([A-Za-z .,]{3,50}(?:Customer|Patel)?)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      quotes.push({ quote: m[1].trim(), author: (m[2] || 'Customer').trim() });
    }
  }
  return quotes.slice(0, 3);
}

function extractFeatureBullets($, text) {
  const bullets = [];
  $('h2, h3, .rich-text, .banner__text, .multicolumn-card, p strong').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 15 && t.length < 180 && !/sold out|regular price|add to cart/i.test(t)) {
      bullets.push(t);
    }
  });
  const fromText = extractLines(text, 15);
  return uniq([...bullets, ...fromText]).slice(0, 12);
}

function extractPolicyLinks($, origin) {
  const links = [];
  $('a[href*="/policies/"], a[href*="/pages/"]').each((_, el) => {
    const href = $(el).attr('href');
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || !label || label.length < 3 || label.length > 80) return;
    if (/^(click here|learn more|read more|shop now)$/i.test(label)) return;
    if (/cart|login|account|search|collection\/all/i.test(href)) return;
    try {
      const full = new URL(href, origin).href;
      links.push({ label, url: full });
    } catch (_) {}
  });
  const seen = new Set();
  return links.filter((l) => {
    const k = l.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
}

function mapShopifyProduct(p, origin) {
  const variant = (p.variants || [])[0] || {};
  const price = formatInr(variant.price);
  const compare = variant.compare_at_price ? formatInr(variant.compare_at_price) : null;
  const available = p.variants?.some((v) => v.available) ?? false;
  const desc = stripHtml(p.body_html).slice(0, 420);
  const url = `${origin}/products/${p.handle}`;
  return {
    title: p.title,
    url,
    status: available ? 'In stock' : 'Sold out',
    price,
    compareAtPrice: compare,
    vendor: p.vendor || null,
    productType: p.product_type || null,
    tags: (p.tags || []).slice(0, 8),
    description: desc,
  };
}

function inferNiche(products, metaDesc) {
  const types = uniq(products.map((p) => p.productType).filter(Boolean));
  if (types.length) return types.join(', ');
  const titles = products.map((p) => p.title).join(' ').toLowerCase();
  if (/doorbell|door phone|security|camera|smart home/i.test(titles)) {
    return 'Smart video doorbells & home security';
  }
  return metaDesc ? metaDesc.slice(0, 120) : 'E-commerce / D2C brand';
}

function sortProducts(products) {
  const rank = (title) => {
    const t = String(title || '').toLowerCase();
    if (/doorbell|door phone/.test(t) && !/bracket|chime|mount/.test(t)) return 0;
    if (/chime|bracket|mount|accessory/.test(t)) return 2;
    return 1;
  };
  return [...products].sort((a, b) => rank(a.title) - rank(b.title));
}

function formatProductSection(products) {
  if (!products.length) return 'No products could be extracted from the website.';
  const lines = [
    '(Note to bot: If status is "Sold out", tell the customer it is currently unavailable.)',
    '',
  ];
  products.forEach((p, i) => {
    lines.push(`### ${i + 1}. ${p.title}`);
    lines.push(`- Status: ${p.status}`);
    if (p.price) lines.push(`- Price: ${p.price}${p.compareAtPrice && p.compareAtPrice !== p.price ? ` (was ${p.compareAtPrice})` : ''}`);
    if (p.url) lines.push(`- Product page: ${p.url}`);
    if (p.vendor) lines.push(`- Brand/Vendor: ${p.vendor}`);
    if (p.tags?.length) lines.push(`- Tags: ${p.tags.join(', ')}`);
    if (p.description) lines.push(`- About: ${p.description}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function formatKnowledgeDocument(data) {
  const {
    origin,
    siteName,
    tagline,
    metaDesc,
    niche,
    contact,
    stats,
    testimonials,
    features,
    integrations,
    products,
    policyLinks,
    salesChannels,
    has24x7Support,
  } = data;

  const phone = contact.phones[0] || 'Not listed on website';
  const email = contact.emails[0] || 'Not listed on website';

  const sections = [];

  sections.push(`# ${siteName} — AI Knowledge Base`);
  sections.push(`Source: ${origin}`);
  sections.push(`Generated by TopEdge from public website data.`);
  sections.push('');

  sections.push('## Assistant Instructions');
  sections.push(`You are the official AI customer support assistant for ${siteName}.`);
  sections.push('- Do not invent, guess, or make up prices, policies, or product specs.');
  sections.push('- Only use facts from this knowledge base.');
  sections.push('- If the answer is not here, politely say so and share support contact details.');
  sections.push(`- Human support: ${phone}${email !== 'Not listed on website' ? ` | ${email}` : ''}.`);
  sections.push('');

  sections.push('## Company Overview');
  sections.push(`- Company: ${siteName}`);
  if (tagline) sections.push(`- Tagline: ${tagline}`);
  if (metaDesc) sections.push(`- About: ${metaDesc}`);
  if (niche) sections.push(`- Niche: ${niche}`);
  if (salesChannels?.length) sections.push(`- Sales channels: ${salesChannels.join(', ')}`);
  sections.push('');

  sections.push('## Contact & Support');
  sections.push(`- Phone: ${phone}`);
  sections.push(`- Email: ${email}`);
  if (contact.address) sections.push(`- Address: ${contact.address}`);
  if (has24x7Support) {
    sections.push('- Support: 24x7 — "Support That Never Sleeps" (as stated on website)');
  }
  sections.push('');

  if (stats.length) {
    sections.push('## Trust & Social Proof');
    stats.forEach((s) => sections.push(`- ${s}`));
    sections.push('');
  }

  if (testimonials.length) {
    sections.push('## Customer Testimonials');
    testimonials.forEach((t) => sections.push(`- "${t.quote}" — ${t.author}`));
    sections.push('');
  }

  if (features.length || integrations.length) {
    sections.push('## Key Features & Integrations');
    features.slice(0, 8).forEach((f) => sections.push(`- ${f}`));
    integrations.forEach((i) => sections.push(`- ${i}`));
    sections.push('');
  }

  sections.push('## Product Catalog');
  sections.push(formatProductSection(products));
  sections.push('');

  if (policyLinks.length) {
    sections.push('## Policies & Help Pages');
    sections.push('(These pages exist on the website — direct customers to the URL for full policy text.)');
    policyLinks.forEach((p) => sections.push(`- ${p.label}: ${p.url}`));
    sections.push('');
  }

  return sections.join('\n').slice(0, 20000);
}

async function maybeEnhanceWithAI(clientId, draft) {
  if (!clientId) return draft;
  try {
    const result = await callAI({
      clientId,
      feature: 'knowledge_import',
      maxTokens: 3500,
      temperature: 0.2,
      systemPrompt:
        'You rewrite extracted website data into a clean WhatsApp AI knowledge base. ' +
        'Never add facts not present in the source. Keep all product names, prices, phone, email, and URLs exactly. ' +
        'Use markdown headings. Be concise but complete.',
      prompt: `Improve formatting only — do not invent data:\n\n${draft.slice(0, 14000)}`,
    });
    const improved = String(result?.content || '').trim();
    return improved.length > 400 ? improved.slice(0, 20000) : draft;
  } catch (_) {
    return draft;
  }
}

async function buildKnowledgeFromWebsite(url, options = {}) {
  const { clientId = null, useAiEnhance = true } = options;
  const origin = normalizeOrigin(url);
  if (!origin) throw new Error('Invalid URL');

  const [html, shopifyProducts] = await Promise.all([
    fetchHtml(url).catch(() => fetchHtml(origin).catch(() => null)),
    fetchShopifyProducts(origin).catch(() => []),
  ]);

  if (!html && !shopifyProducts.length) {
    throw new Error('Could not fetch website content.');
  }

  const $ = cheerio.load(html || '<html></html>');
  const jsonLd = parseJsonLd($);

  const title = $('title').first().text().trim();
  const ogSite = $('meta[property="og:site_name"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const metaDesc =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const siteName =
    ogSite ||
    jsonLd.org?.name ||
    (title || '').split('|')[0].split('-')[0].trim() ||
    new URL(origin).hostname;

  removeNoise($);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const contact = extractContact(bodyText);
  const stats = extractStats(bodyText);
  const testimonials = extractTestimonials(bodyText);
  const features = extractFeatureBullets($, bodyText);
  const policyLinks = extractPolicyLinks(cheerio.load(html), origin);

  const h1 = $('h1, .banner__heading, .hero__title').first().text().replace(/\s+/g, ' ').trim();
  const shortTagline = $('h2, .banner__text p, .rich-text h2').first().text().replace(/\s+/g, ' ').trim();
  const tagline =
    (h1 && h1.length < 90 && !/sold out|regular price/i.test(h1) ? h1 : null) ||
    (shortTagline && shortTagline.length < 90 ? shortTagline : null) ||
    features.find((f) => f.length < 80 && /future|home|protection|smart/i.test(f)) ||
    metaDesc.slice(0, 100);

  const integrations = [];
  if (/alexa/i.test(bodyText)) integrations.push('Amazon Alexa — motion alerts, live video, two-way talk, routines');
  if (/cloudedge/i.test(bodyText)) integrations.push('CloudEdge mobile app');
  if (/amazon/i.test(bodyText)) integrations.push('Also sold on Amazon');

  const salesChannels = uniq([
    'Official website',
    /amazon/i.test(bodyText) ? 'Amazon Store' : null,
  ]);

  const products = sortProducts(
    shopifyProducts.length
      ? shopifyProducts.map((p) => mapShopifyProduct(p, origin))
      : (jsonLd.products || []).map((p) => ({
          title: p.name,
          url: p.url || origin,
          status: p.offers?.availability?.includes('InStock') ? 'In stock' : 'See website',
          price: p.offers?.price ? formatInr(p.offers.price) : null,
          compareAtPrice: null,
          vendor: siteName,
          productType: null,
          tags: [],
          description: stripHtml(p.description).slice(0, 420),
        }))
  );

  const niche = inferNiche(products, metaDesc);
  const has24x7Support = /support that never sleeps|24\s*x\s*7|24\/7|call us anytime/i.test(bodyText);

  let document = formatKnowledgeDocument({
    origin,
    siteName,
    tagline,
    metaDesc,
    niche,
    contact,
    stats,
    testimonials,
    features,
    integrations,
    products,
    policyLinks,
    salesChannels,
    has24x7Support,
  });

  if (useAiEnhance && clientId) {
    document = await maybeEnhanceWithAI(clientId, document);
  }

  if (document.length < 200) {
    throw new Error('Could not extract enough structured content from that website.');
  }

  return {
    content: document,
    title: `${siteName} — Knowledge Base`.slice(0, 200),
    siteName,
    productCount: products.length,
    origin,
  };
}

/** Legacy plain-text scrape — prefer buildKnowledgeFromWebsite. */
async function scrapeWebsiteText(url) {
  const built = await buildKnowledgeFromWebsite(url, { useAiEnhance: false });
  return built.content;
}

module.exports = {
  buildKnowledgeFromWebsite,
  scrapeWebsiteText,
  normalizeOrigin,
};
