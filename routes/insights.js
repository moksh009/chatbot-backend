const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const { protect } = require('../middleware/auth');
const { getGeminiModel } = require('../utils/gemini');

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

    // Use geminiApiKey first, then openaiApiKey (legacy alias), then server key
    const apiKey = client.geminiApiKey?.trim() || client.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    
    // If no AI key, return mock insights instead of crashing
    if (!apiKey) {
      const mockInsights = [
        { type: 'info', message: 'Connect a Gemini API key in Settings → AI Engine to unlock AI-powered insights.', actionUrl: '/settings', estimatedValue: 0, generatedAt: new Date() },
        { type: 'success', message: `${stats.length > 0 ? stats[0].messagesReceived || 0 : 0} messages received this week. Keep engaging your customers!`, actionUrl: '/analytics', estimatedValue: 0, generatedAt: new Date() },
        { type: 'warning', message: 'Run a campaign to re-engage inactive leads and boost conversions.', actionUrl: '/campaigns', estimatedValue: 500, generatedAt: new Date() }
      ];
      if (!client.businessName) client.businessName = clientId;
      client.insights = mockInsights;
      await client.save();
      return res.json({ success: true, insights: mockInsights });
    }

    const model = getGeminiModel(apiKey);
    const prompt = `
    Analyze the following 7-day stats for a business on WhatsApp:
    ${JSON.stringify(stats)}
    Generate exactly 3 extremely short, actionable "Smart Insights" (max 2 sentences each). 
    Return a valid JSON array of objects with keys: { "type": "info"|"warning"|"success", "message": "string", "actionUrl": "/campaigns" | "/leads" | "/analytics", "estimatedValue": number }
    No markdown blocks, just raw JSON.
    `;

    const result = await model.generateContent(prompt);
    let outputText = result.response.text().trim();
    
    // Improved JSON extraction: find the first '[' and last ']'
    const jsonMatch = outputText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("Could not find JSON array in AI response");
    }
    outputText = jsonMatch[0];

    const newInsights = JSON.parse(outputText);
    if (!Array.isArray(newInsights)) {
      throw new Error("AI response is not a JSON array");
    }
    
    // Validate and Clean: Filter out invalid objects and map to schema
    const finalInsights = newInsights
      .filter(i => i && typeof i === 'object' && i.message)
      .map(i => ({ 
        type: ['info', 'warning', 'success'].includes(i.type) ? i.type : 'info',
        message: String(i.message).slice(0, 500),
        actionUrl: String(i.actionUrl || '/analytics'),
        estimatedValue: Number(i.estimatedValue) || 0,
        generatedAt: new Date()
      }));
    
    if (!client.businessName) client.businessName = client.clientId || clientId;
    client.insights = finalInsights;
    await client.save();
    
    res.json({ success: true, insights: finalInsights });
  } catch (error) {
    console.error('Insight generation error:', error);
    // Return graceful fallback instead of 500
    const fallback = [
      { type: 'warning', message: 'AI insight generation encountered an issue. Check your Gemini API key in Settings.', actionUrl: '/settings', estimatedValue: 0, generatedAt: new Date() }
    ];
    res.json({ success: true, insights: fallback });
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
