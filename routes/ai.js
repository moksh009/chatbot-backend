const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const log = require('../utils/logger')('AIRoutes');

/**
 * POST /api/ai/generate-faq
 * Scrapes a website URL with AI and auto-generates:
 * - FAQ entries
 * - Business description
 * - Suggested persona config
 * - Knowledge base content
 */
router.post('/generate-faq', protect, async (req, res) => {
  try {
    const { websiteUrl } = req.body;
    const clientId = req.user.clientId;

    if (!websiteUrl) {
      return res.status(400).json({ success: false, message: 'websiteUrl is required' });
    }

    // Validate URL format
    let url;
    try {
      url = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid URL format' });
    }

    // Fetch client's API key
    const client = await Client.findOne({ clientId }).select('geminiApiKey openaiApiKey').lean();
    const apiKey = client?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();

    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'No AI API key configured. Please add your Gemini API key in Settings.' });
    }

    // Step 1: Scrape the website
    log.info(`Scraping website: ${url.href} for client ${clientId}`);
    const axios = require('axios');
    let pageContent = '';

    try {
      const scrapeRes = await axios.get(url.href, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TopEdgeAI/1.0; +https://topedgeai.com)',
          'Accept': 'text/html,application/xhtml+xml'
        },
        maxRedirects: 5
      });

      // Extract text content from HTML (strip tags)
      pageContent = scrapeRes.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 8000); // Limit to 8K chars for Gemini context
    } catch (scrapeErr) {
      log.warn(`Failed to scrape ${url.href}: ${scrapeErr.message}`);
      return res.status(400).json({ success: false, message: `Could not access website: ${scrapeErr.message}` });
    }

    if (pageContent.length < 50) {
      return res.status(400).json({ success: false, message: 'Website content too short to analyze. Make sure the URL has readable content.' });
    }

    // Step 2: Use Gemini to generate FAQ + knowledge base
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are analyzing a business website to generate a customer support knowledge base.

Website URL: ${url.href}
Website Content:
---
${pageContent}
---

Generate a JSON response with EXACTLY this structure (no markdown, just pure JSON):
{
  "businessDescription": "A 2-3 sentence description of what this business does",
  "faqs": [
    { "question": "...", "answer": "..." }
  ],
  "suggestedPersona": {
    "name": "A fitting assistant name for this brand",
    "tone": "One of: Professional & Helpful, Casual & Friendly, Luxury & Exclusive, Direct & Technical, Enthusiastic & Salesy",
    "description": "A brief persona description"
  },
  "policies": {
    "returnPolicy": "Extracted or inferred return policy (or empty string)",
    "shippingPolicy": "Extracted or inferred shipping info (or empty string)",
    "contactInfo": "Extracted contact details (or empty string)"
  },
  "keywords": ["top", "5", "business", "keywords"]
}

Generate 8-12 high-quality FAQ entries that a customer would actually ask. Make answers concise but helpful. If certain information is not available on the website, make reasonable inferences based on the business type.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Parse the JSON response
    let aiData;
    try {
      // Strip markdown code blocks if present
      const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      aiData = JSON.parse(cleanJson);
    } catch (parseErr) {
      log.error('Failed to parse AI response:', parseErr.message);
      return res.status(500).json({ success: false, message: 'AI generated invalid response. Please try again.' });
    }

    // Step 3: Save to client document
    const updatePayload = {};
    if (aiData.faqs?.length > 0) {
      updatePayload['faq'] = aiData.faqs.map((f, i) => ({ question: f.question, answer: f.answer, order: i }));
    }
    if (aiData.businessDescription) {
      updatePayload['ai.persona.description'] = aiData.businessDescription;
    }
    if (aiData.suggestedPersona?.name) {
      updatePayload['ai.persona.suggestedName'] = aiData.suggestedPersona.name;
    }
    if (aiData.policies?.returnPolicy) {
      updatePayload['knowledgeBase.returnPolicy'] = aiData.policies.returnPolicy;
    }
    if (aiData.policies?.shippingPolicy) {
      updatePayload['knowledgeBase.shippingPolicy'] = aiData.policies.shippingPolicy;
    }
    if (aiData.policies?.contactInfo) {
      updatePayload['knowledgeBase.contact.raw'] = aiData.policies.contactInfo;
    }
    updatePayload['websiteUrl'] = url.href;

    if (Object.keys(updatePayload).length > 0) {
      await Client.updateOne({ clientId }, { $set: updatePayload });
    }

    res.json({
      success: true,
      data: aiData,
      savedFields: Object.keys(updatePayload)
    });

  } catch (error) {
    log.error('FAQ generation error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to generate FAQ: ' + error.message });
  }
});

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
