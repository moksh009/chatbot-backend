const express = require('express');
const router = express.Router();
const audienceStack = require('./audienceStack');
const { protect } = require('../middleware/auth');

router.use(audienceStack);
const ImportSession = require('../models/ImportSession');
const { tenantClientId } = require('../utils/core/queryHelpers');
const axios = require('axios');

// ── Colour helpers ──────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    return u.origin;
  } catch { return null; }
}

/** Extract all hex/rgb colours mentioned in inline style attrs + CSS variables */
function extractColors(html) {
  const found = new Set();
  // hex colours
  const hexRe = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m;
  while ((m = hexRe.exec(html)) !== null) found.add(m[0]);
  // rgb() / rgba()
  const rgbRe = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  while ((m = rgbRe.exec(html)) !== null) {
    const [r, g, b] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    found.add(hex);
  }
  // CSS variables pointing to colors
  const cssVarRe = /--[\w-]+:\s*(#[0-9a-fA-F]{3,6})/g;
  while ((m = cssVarRe.exec(html)) !== null) found.add(m[1]);
  return [...found];
}

/** Score a hex color for "brand primary" likelihood (not white/near-white/black) */
function scoreBrandColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (r + g + b) / (3 * 255);
  if (lum > 0.88 || lum < 0.05) return 0; // near white or black
  // Prefer saturated colors
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return sat;
}

// POST /api/audience/widget-theme-fetch
router.post('/widget-theme-fetch', protect, async (req, res) => {
  try {
    const { websiteUrl } = req.body || {};
    const origin = normalizeUrl(websiteUrl);
    if (!origin) {
      return res.status(400).json({ success: false, message: 'Invalid or missing websiteUrl' });
    }

    const resp = await axios.get(origin, {
      timeout: 8000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (TopEdgeAI Widget Builder) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const html = resp.data || '';

    // ── cheerio for meta / theme-color ──
    let themeColor = '';
    let title = '';
    let favicon = '';
    let fontFamily = '';

    try {
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);
      themeColor = $('meta[name="theme-color"]').attr('content') || '';
      title = $('title').first().text().trim();
      favicon =
        $('link[rel="icon"]').attr('href') ||
        $('link[rel="shortcut icon"]').attr('href') ||
        $('link[rel="apple-touch-icon"]').attr('href') ||
        '';
      // Google Fonts link tag
      const gfLink = $('link[href*="fonts.googleapis.com"]').attr('href') || '';
      const famMatch = gfLink.match(/family=([^:&|]+)/);
      if (famMatch) fontFamily = decodeURIComponent(famMatch[1]).replace(/\+/g, ' ').split(':')[0].trim();
      // Inline CSS @import Google Font
      if (!fontFamily) {
        const styleImport = html.match(/fonts\.googleapis\.com\/css[^'"]+family=([^:&'"\s|]+)/);
        if (styleImport) fontFamily = decodeURIComponent(styleImport[1]).replace(/\+/g, ' ').split(':')[0].trim();
      }
    } catch (_) { /* cheerio may not be available */ }

    // ── Colour extraction ──
    const allColors = extractColors(html);
    const candidates = allColors
      .filter(h => h.length === 7)
      .map(h => ({ hex: h, score: scoreBrandColor(h) }))
      .filter(c => c.score > 0.3)
      .sort((a, b) => b.score - a.score);

    const primaryColor = themeColor || candidates[0]?.hex || '#7C3AED';
    const accentColor = candidates[1]?.hex || primaryColor;

    // Resolve favicon to absolute URL
    if (favicon && !/^https?:\/\//i.test(favicon)) {
      try { favicon = new URL(favicon, origin).toString(); } catch (_) { favicon = ''; }
    }

    return res.json({
      success: true,
      origin,
      title,
      primaryColor,
      accentColor,
      fontFamily: fontFamily || 'Inter',
      favicon,
      topColors: candidates.slice(0, 5).map(c => c.hex),
    });
  } catch (err) {
    console.error('[AudienceThemeFetch]', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch website theme', error: err.message });
  }
});

// @route   GET /api/audience/import-batches
// @desc    Get all completed import batches for a client
// @access  Private
router.get('/import-batches', protect, async (req, res) => {
  try {
    const cid = tenantClientId(req);
    if (!cid) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const batches = await ImportSession.find({ 
      clientId: cid, 
      status: 'completed' 
    })
    .sort({ createdAt: -1 })
    .select('batchName batchId filename successCount newPhones createdAt status')
    .lean();

    // Map to expected frontend format
    const formattedBatches = batches.map(b => ({
      _id: b._id,
      batchId: b.batchId,
      batchName: b.batchName || b.filename,
      filename: b.filename,
      successCount: b.successCount,
      newCount: b.newPhones ? b.newPhones.length : 0,
      createdAt: b.createdAt
    }));

    res.json({ success: true, batches: formattedBatches });
  } catch (err) {
    console.error('[Audience] Fetch import batches error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch import batches' });
  }
});

module.exports = router;
