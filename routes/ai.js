const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const log = require('../utils/core/logger')('AIRoutes');

/**
 * POST /api/ai/crawl-faq
 * Lightweight HTML fetch + cheerio text extraction for wizard "FAQ URL" step.
 * Stores trimmed text on client.ai.persona.knowledgeBase (max 5000 chars).
 */
router.post('/crawl-faq', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { faqUrl } = req.body || {};
    if (!faqUrl || !String(faqUrl).trim()) {
      return res.status(400).json({ success: false, message: 'faqUrl is required' });
    }
    let url;
    try {
      url = new URL(String(faqUrl).trim().startsWith('http') ? String(faqUrl).trim() : `https://${String(faqUrl).trim()}`);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid faqUrl' });
    }

    const axios = require('axios');
    const cheerio = require('cheerio');

    const resp = await axios.get(url.href, {
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TopEdgeAI/1.0; +https://topedgeai.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const html = String(resp.data || '');
    const $ = cheerio.load(html);
    $('script, style, nav, footer, noscript, svg').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);

    if (text.length < 80) {
      return res.json({
        success: false,
        crawlOk: false,
        message: 'Could not extract enough text from this page. Paste your FAQ manually.',
        charCount: text.length,
      });
    }

    await Client.updateOne(
      { clientId },
      { $set: { 'ai.persona.knowledgeBase': text, faqUrl: url.href } }
    );

    const approxQuestions = (text.match(/\?/g) || []).length;
    res.json({
      success: true,
      crawlOk: true,
      charCount: text.length,
      approxQuestions,
      knowledgeBase: text,
      faqUrl: url.href,
    });
  } catch (err) {
    log.error('crawl-faq error:', err.message);
    res.status(500).json({
      success: false,
      crawlOk: false,
      message: err.response?.data?.message || err.message || 'Crawl failed',
    });
  }
});

module.exports = router;
