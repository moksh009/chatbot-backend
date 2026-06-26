'use strict';

const axios = require('axios');
const { URL } = require('url');
const dns = require('dns').promises;
const Client = require('../models/Client');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');

const FETCH_TIMEOUT_MS = 10000;
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) throw new Error('URL host not allowed');
  const records = await dns.lookup(host, { all: true }).catch(() => []);
  for (const rec of records) {
    if (isPrivateIp(rec.address)) throw new Error('URL resolves to private network');
  }
  return parsed.href;
}

function extractHexColors(html) {
  const found = new Set();
  const hexRe = /#([0-9a-fA-F]{6})\b/g;
  let m;
  while ((m = hexRe.exec(html))) {
    found.add(`#${m[1].toUpperCase()}`);
    if (found.size >= 8) break;
  }
  return [...found];
}

function extractThemeColor(html) {
  const meta = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
  if (meta?.[1] && /^#[0-9a-fA-F]{6}$/i.test(meta[1].trim())) return meta[1].trim().toUpperCase();
  const meta2 = html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{6})["'][^>]+name=["']theme-color["']/i);
  return meta2?.[1]?.toUpperCase() || null;
}

function extractFontFamily(html) {
  const google = html.match(/fonts\.googleapis\.com\/css2?\?family=([^&"']+)/i);
  if (google?.[1]) return decodeURIComponent(google[1].split(':')[0].replace(/\+/g, ' '));
  const link = html.match(/font-family:\s*['"]?([^;'"]+)/i);
  if (link?.[1]) return link[1].trim().split(',')[0].replace(/['"]/g, '');
  return 'Inter';
}

async function extractFromShopifyBrand(clientId) {
  const client = await Client.findOne({ clientId })
    .select('shopDomain shopifyAccessToken shopifyConnectionStatus shopifyStores commerce brand businessName')
    .lean();
  if (!buildConnectionStatusPayload(client).shopify_connected) return null;
  const primary = client.brand?.primaryColor || client.brand?.color || null;
  if (!primary) return null;
  return {
    primary: primary.startsWith('#') ? primary : `#${primary}`,
    secondary: '#5B21B6',
    background: '#FFFFFF',
    text: '#0F172A',
    fontFamily: 'Inter',
    confidence: 'medium',
  };
}

async function extractBrandFromUrl(clientId, rawUrl) {
  const safeUrl = await assertSafeUrl(rawUrl);
  const response = await axios.get(safeUrl, {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 3,
    headers: { 'User-Agent': 'TopEdge-BrandExtract/1.0' },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const html = String(response.data || '');
  const themeColor = extractThemeColor(html);
  const colors = extractHexColors(html);
  const primary = themeColor || colors[0] || '#7C3AED';
  const secondary = colors[1] || '#5B21B6';
  const fontFamily = extractFontFamily(html);

  let confidence = 'low';
  if (themeColor) confidence = 'high';
  else if (colors.length >= 2) confidence = 'medium';

  if (confidence === 'low') {
    const shopify = await extractFromShopifyBrand(clientId);
    if (shopify) return shopify;
  }

  return {
    primary,
    secondary,
    background: '#FFFFFF',
    text: '#0F172A',
    fontFamily,
    confidence,
  };
}

module.exports = { extractBrandFromUrl, assertSafeUrl };
