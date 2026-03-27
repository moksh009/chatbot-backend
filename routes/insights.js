const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const { protect } = require('../middleware/auth');
const { GoogleGenerativeAI } = require("@google/generative-ai");

router.post('/generate/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Ensure permission
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Fetch last 7 days of DailyStat
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const stats = await DailyStat.find({
      clientId,
      date: { $gte: weekAgo.toISOString().split('T')[0] }
    }).sort({ date: -1 });

    // Initialize Gemini (falling back to server key if client has none)
    const apiKey = client.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'No AI token configured' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-04-17" });

    // Construct prompt
    const prompt = `
    Analyze the following 7-day stats for a business on WhatsApp:
    ${JSON.stringify(stats)}
    Generate exactly 3 extremely short, actionable "Smart Insights" (max 2 sentences each).
    Return a valid JSON array of objects with keys: { "type": "info"|"warning"|"success", "message": "string", "actionUrl": "/campaigns" | "/leads" | "/analytics", "estimatedValue": number }
    No markdown blocks, just raw JSON.
    `;

    const result = await model.generateContent(prompt);
    let outputText = result.response.text().trim();
    if (outputText.startsWith('```json')) outputText = outputText.slice(7, -3).trim();

    const newInsights = JSON.parse(outputText);
    
    // Append generated date
    const finalInsights = newInsights.map(i => ({ ...i, generatedAt: new Date() }));
    
    client.insights = finalInsights;
    await client.save();
    
    res.json({ success: true, insights: finalInsights });
  } catch (error) {
    console.error('Insight generation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Ensure permission
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId });
    res.json({ success: true, insights: client?.insights || [] });
  } catch (error) {
    console.error('Insights fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
