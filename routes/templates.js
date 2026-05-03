const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/queryHelpers');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');
const log = require('../utils/logger')('TemplateAPI');
const { decrypt } = require('../utils/encryption');
const Client = require('../models/Client');
const User = require('../models/User');
const { STANDARD_TEMPLATES } = require('../constants/standardTemplates');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { getFastScore, analyzeWithGeminiAndRewrite } = require('../utils/templateScorer');

// --- Helper Functions ---
async function getClientCredentials(clientId, userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // SUPER_ADMIN can access any client; others can only access their own clientId
    if (user.role !== 'SUPER_ADMIN' && user.clientId !== clientId) {
        throw new Error('Unauthorized: You can only manage templates for your own client.');
    }

    const client = await Client.findOne({ clientId });

    if (!client) throw new Error('Client not found');
    const wabaId = client.wabaId || client.whatsapp?.wabaId;
    const rawToken = client.whatsappToken || client.whatsapp?.accessToken;
    if (!wabaId) throw new Error('WABA ID (WhatsApp Business Account ID) is not configured for this client.');
    if (!rawToken) throw new Error('WhatsApp Token is not configured for this client.');
    client.wabaId = wabaId;
    client.whatsappToken = decrypt(rawToken) || rawToken;

    return client;
}

// 1. Fetch All Templates from Meta
router.get('/sync', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

        const client = await getClientCredentials(clientId, req.user.id);

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates?fields=name,status,category,language,components`;
        
        try {
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${client.whatsappToken}` }
            });
            let templates = response.data.data || [];
            
            // Enrich with variable metrics
            templates = templates.map(tpl => {
                let bodyVars = 0;
                let headerVars = 0;
                let headerFormat = 'NONE';
                
                if (tpl.components) {
                    const bodyComp = tpl.components.find(c => c.type === 'BODY');
                    if (bodyComp && bodyComp.text) {
                        const paramMatches = bodyComp.text.match(/{{(\d+)}}/g) || [];
                        if (paramMatches.length > 0) {
                            bodyVars = Math.max(...paramMatches.map(m => parseInt(m.match(/\d+/)[0])));
                        }
                    }
                    
                    const headerComp = tpl.components.find(c => c.type === 'HEADER');
                    if (headerComp) {
                        headerFormat = headerComp.format || 'NONE';
                        if (headerComp.text) {
                            const paramMatches = headerComp.text.match(/{{(\d+)}}/g) || [];
                            if (paramMatches.length > 0) {
                                headerVars = Math.max(...paramMatches.map(m => parseInt(m.match(/\d+/)[0])));
                            }
                        }
                    }
                }
                
                return {
                    ...tpl,
                    variableMetrics: {
                        bodyVariables: bodyVars,
                        headerVariables: headerVars,
                        totalVariables: bodyVars + headerVars,
                        headerFormat
                    }
                };
            });

            // PERSIST to Client model so backend can use them for param detection
            await Client.updateOne(
                { clientId },
                { $set: { syncedMetaTemplates: templates, templatesSyncedAt: new Date() } }
            );

            res.json({ success: true, data: templates });
        } catch (metaErr) {
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            console.error('[Template API] Meta Sync Error:', metaErr.response?.data || metaErr.message);
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to sync templates from Meta', 
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }
    } catch (error) {
        console.error('[Template API] Sync Error:', error.message);
        const isMissingCredentials = error.message.includes('not configured') || error.message.includes('Unauthorized');
        res.status(isMissingCredentials ? 400 : 500).json({ 
            success: false, 
            message: error.message,
            isIntegrationAuthError: isMissingCredentials
        });
    }
});

// 1b. Fetch Templates from Local DB Cache (Lightweight)
router.get('/list', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

        const client = await Client.findOne({ clientId }, 'syncedMetaTemplates templatesSyncedAt messageTemplates pendingTemplates');
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
        const localTemplates = Array.isArray(client.messageTemplates) ? client.messageTemplates : [];
        const pendingMap = new Map((Array.isArray(client.pendingTemplates) ? client.pendingTemplates : []).map(t => [t.name, String(t.status || 'PENDING').toUpperCase()]));

        // Prefer local messageTemplates for rich metadata/source, but hydrate status from synced/pending.
        const mergedMap = new Map();
        localTemplates.forEach((tpl) => {
          if (!tpl?.name) return;
          const pendingStatus = pendingMap.get(tpl.name);
          const status = pendingStatus || String(tpl.status || 'PENDING').toUpperCase();
          mergedMap.set(tpl.name, { ...tpl, status });
        });

        synced.forEach((tpl) => {
          if (!tpl?.name) return;
          if (mergedMap.has(tpl.name)) {
            const existing = mergedMap.get(tpl.name);
            mergedMap.set(tpl.name, {
              ...tpl,
              ...existing,
              status: String(tpl.status || existing.status || 'APPROVED').toUpperCase(),
              source: existing.source || 'synced_meta'
            });
          } else {
            mergedMap.set(tpl.name, {
              ...tpl,
              status: String(tpl.status || 'APPROVED').toUpperCase(),
              source: tpl.source || 'synced_meta'
            });
          }
        });

        const merged = Array.from(mergedMap.values());
        res.json({
          success: true,
          data: merged,
          syncedAt: client.templatesSyncedAt
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update AI-generated product template locally before Meta publish.
router.put('/product-template/:clientId/:templateName', protect, async (req, res) => {
    try {
        const { clientId, templateName } = req.params;
        const { body, footer, imageUrl, variables = {} } = req.body || {};
        if (!templateName) return res.status(400).json({ success: false, message: 'templateName required' });

        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (user.role !== 'SUPER_ADMIN' && user.clientId !== clientId) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const templates = Array.isArray(client.messageTemplates) ? [...client.messageTemplates] : [];
        const idx = templates.findIndex(t => t?.name === templateName);
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Template not found in local workspace' });
        }

        const tpl = { ...templates[idx] };
        if (String(tpl.name || '').startsWith('prod_') === false && tpl.source !== 'wizard_product') {
          return res.status(400).json({ success: false, message: 'Only AI-generated product templates can be edited here' });
        }

        const components = Array.isArray(tpl.components) ? [...tpl.components] : [];
        const bodyIndex = components.findIndex(c => c.type === 'BODY');
        const footerIndex = components.findIndex(c => c.type === 'FOOTER');
        const headerIndex = components.findIndex(c => c.type === 'HEADER' && c.format === 'IMAGE');

        if (body !== undefined) {
          if (bodyIndex >= 0) components[bodyIndex] = { ...components[bodyIndex], text: body };
          else components.push({ type: 'BODY', text: body });
          tpl.body = body;
        }
        if (footer !== undefined) {
          if (footerIndex >= 0) components[footerIndex] = { ...components[footerIndex], text: footer };
          else components.push({ type: 'FOOTER', text: footer });
        }
        if (imageUrl !== undefined) {
          if (headerIndex >= 0) components[headerIndex] = { ...components[headerIndex], _imageUrl: imageUrl };
          else components.unshift({ type: 'HEADER', format: 'IMAGE', _imageUrl: imageUrl });
          tpl.imageUrl = imageUrl;
        }

        const vars = Array.isArray(tpl.variables) ? [...tpl.variables] : ['product_name', 'product_price', 'product_features'];
        if (variables.productName !== undefined) vars[0] = variables.productName;
        if (variables.productPrice !== undefined) vars[1] = variables.productPrice;
        if (variables.productFeatures !== undefined) vars[2] = variables.productFeatures;
        tpl.variables = vars;
        tpl.components = components;
        tpl.updatedAt = new Date();
        tpl.status = String(tpl.status || 'DRAFT').toUpperCase() === 'APPROVED' ? 'APPROVED' : 'DRAFT';

        templates[idx] = tpl;
        await Client.updateOne({ clientId }, { $set: { messageTemplates: templates } });

        res.json({ success: true, template: tpl });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Get Template Statistics (Read Rate and Revenue)
router.get('/:clientId/stats', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const Message = require('../models/Message');
        const Order = require('../models/Order');

        // Verify access
        await getClientCredentials(clientId, req.user.id);

        // Fetch real messages to calculate Read Rate
        const totalSent = await Message.countDocuments({ clientId, direction: 'outgoing', type: 'template' });
        const totalRead = await Message.countDocuments({ clientId, direction: 'outgoing', status: 'read' });
        const totalDelivered = await Message.countDocuments({ clientId, direction: 'outgoing', status: 'delivered' });
        
        const readRate = totalSent > 0 ? Math.round((totalRead / totalSent) * 100) : 0;
        const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0;

        // Fetch revenue (simplified: total revenue for the client)
        const stats = await Order.aggregate([
            { $match: { clientId } },
            { $group: { _id: null, totalRevenue: { $sum: "$totalPrice" } } }
        ]);
        
        const revenue = stats.length > 0 ? stats[0].totalRevenue : 0;

        // Fetch the list of synced templates from the client document for the count
        const client = await Client.findOne({ clientId });
        
        res.json({
            success: true,
            globalReadRate: readRate || 32, // Weighted fallback
            globalRevenue: revenue || 0,
            deliveryRate: deliveryRate || 98,
            totalSent,
            activeTemplates: (client?.syncedMetaTemplates || []).length,
            attribution: {
                direct: Math.round(revenue * 0.45), // 45% estimated from templates
                organic: Math.round(revenue * 0.55),
                roi: totalSent > 0 ? ((revenue / (totalSent * 0.8)) * 100).toFixed(1) : "0.0"
            }
        });

    } catch (error) {
        console.error('[Template Stats API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Create a Template on Meta
router.post('/create', protect, async (req, res) => {
    try {
        const { clientId, name, category, language, components } = req.body;
        if (!clientId || !name || !category || !language || !components) {
            return res.status(400).json({ success: false, message: 'Missing required template fields' });
        }

        const client = await getClientCredentials(clientId, req.user.id);

        // --- Meta API Rate Limiting (approx 6 per hour for new WABAs) ---
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        let recentSubmissions = client.templateSubmissionTimestamps || [];
        recentSubmissions = recentSubmissions.filter(ts => new Date(ts) > oneHourAgo);
        
        if (recentSubmissions.length >= 6) {
            return res.status(429).json({
                success: false,
                message: 'Meta API Rate Limit reached: You can only submit 6 templates per hour. Please wait before submitting more.',
                code: 'RATE_LIMIT_EXCEEDED'
            });
        }

        // Required API parameters for Meta Template creation
        const payload = {
            name,
            language,
            category,
            components
        };

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates`;

        try {
            const response = await axios.post(url, payload, {
                headers: { 
                    'Authorization': `Bearer ${client.whatsappToken}`,
                    'Content-Type': 'application/json'
                }
            });

            // Track submission
            recentSubmissions.push(new Date());
            await Client.updateOne(
                { clientId },
                { $set: { templateSubmissionTimestamps: recentSubmissions } }
            );

            res.json({ success: true, data: response.data });
        } catch (metaErr) {
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            console.error('[Template API] Meta Create Error:', metaErr.response?.data || metaErr.message);
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to create template on Meta', 
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }

    } catch (error) {
        console.error('[Template API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Delete a Template from Meta
router.delete('/:name', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
        const templateName = req.params.name;

        const client = await getClientCredentials(clientId, req.user.id);
        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates?name=${templateName}`;

        try {
            const response = await axios.delete(url, {
                headers: { Authorization: `Bearer ${client.whatsappToken}` }
            });
            res.json({ success: true, message: 'Template deleted successfully' });
        } catch (metaErr) {
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to delete template', 
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. AI Copy Generation (Gemini)
router.post('/:clientId/ai-generate', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const { prompt, tone, audience } = req.body;
        
        const client = await Client.findOne({ clientId });
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const apiKey = client.geminiApiKey?.trim() || client.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const finalPrompt = `
        Act as a master WhatsApp marketer.
        Write 3 short diverse WhatsApp template body copies.
        They must be 1-2 paragraphs max. Tone: ${tone}. Target: ${audience}.
        Context: ${prompt}
        Output ONLY a JSON array of 3 strings. Provide NO other text, markdown blocks are okay if standard JSON.
        `;
        const result = await model.generateContent(finalPrompt);
        let outputText = result.response.text().trim();
        if (outputText.startsWith('\`\`\`json')) outputText = outputText.slice(7, -3).trim();
        
        res.json({ success: true, copies: JSON.parse(outputText) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4b. Template Scorer & Fix Suggestion
router.post('/:clientId/score', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const { templateContent, category, action } = req.body;
        // action can be 'score' (fast, regex based) or 'suggest' (deep Gemini analysis)

        if (!templateContent || !category) {
            return res.status(400).json({ success: false, message: 'Missing templateContent or category' });
        }

        if (action === 'score') {
            const scoreData = getFastScore(templateContent, category);
            return res.json({ success: true, ...scoreData });
        } else if (action === 'suggest') {
            const client = await Client.findOne({ clientId });
            if (!client) throw new Error('Client not found');

            const apiKey = client.geminiKey?.trim() || client.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
            if (!apiKey) throw new Error('AI API Key not configured');

            const geminiAnalysis = await analyzeWithGeminiAndRewrite(templateContent, category, apiKey);
            if (!geminiAnalysis) {
                return res.status(500).json({ success: false, message: 'Failed to generate suggestions' });
            }

            return res.json({ success: true, data: geminiAnalysis });
        } else {
            return res.status(400).json({ success: false, message: 'Invalid action type' });
        }
    } catch (error) {
        console.error('[Template Scorer API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 5. Template History
router.get('/:clientId/:templateId/history', protect, async (req, res) => {
    // Dummy return, ideally we store historical documents in a separate collection.
    res.json({ success: true, history: [] });
});

// 6. Fetch Standard Templates Library
router.get('/standard', protect, async (req, res) => {
    res.json({ success: true, data: STANDARD_TEMPLATES });
});

// 7. Push Standard Template to Meta
router.post('/push-standard', protect, async (req, res) => {
    try {
        const { clientId, templateId, headerHandle } = req.body;
        if (!clientId || !templateId) {
            return res.status(400).json({ success: false, message: 'clientId and templateId are required' });
        }

        const standardTemplate = JSON.parse(JSON.stringify(STANDARD_TEMPLATES.find(t => t.id === templateId)));
        if (!standardTemplate) {
            return res.status(404).json({ success: false, message: 'Standard template not found' });
        }

        const client = await getClientCredentials(clientId, req.user.id);

        // Inject Custom Header Handle if provided
        if (headerHandle) {
            const headerComp = standardTemplate.components.find(c => c.type === 'HEADER' && c.format === 'IMAGE');
            if (headerComp) {
                headerComp.example = { header_handle: [headerHandle] };
            }
        }

        const payload = {
            name: standardTemplate.name,
            language: standardTemplate.language,
            category: standardTemplate.category,
            components: standardTemplate.components
        };

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates`;

        try {
            const response = await axios.post(url, payload, {
                headers: { 
                    'Authorization': `Bearer ${client.whatsappToken}`,
                    'Content-Type': 'application/json'
                }
            });
            res.json({ success: true, data: response.data });
        } catch (metaErr) {
            const errData = metaErr.response?.data || metaErr.message;
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            console.error('[Template API] Meta Push Error:', JSON.stringify(errData, null, 2));
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to push template to Meta', 
                details: errData,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 8. Upload Media to Meta (Resumable Upload API)
router.post('/upload-media', protect, upload.single('file'), async (req, res) => {
    try {
        const { clientId } = req.body;
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const client = await getClientCredentials(clientId, req.user.id);
        const accessToken = client.whatsappToken;

        // Meta requires App ID for uploads. 
        // We prioritize process.env.META_APP_ID, then fallback to client.metaAppId from DB.
        const appId = process.env.META_APP_ID || client.metaAppId; 
        
        if (!appId) {
            throw new Error('Meta App ID is not configured. Please set META_APP_ID in your environment or add it in Settings → WhatsApp to use media templates.');
        }
        
        // 1. Initialize Upload
        // Documentation: https://developers.facebook.com/docs/graph-api/resumable-upload-api/
        const initUrl = `https://graph.facebook.com/v21.0/${appId}/uploads`;
        const initRes = await axios.post(initUrl, null, {
            params: {
                file_name: req.file.originalname || `upload_${Date.now()}.jpg`,
                file_length: req.file.size,
                file_type: req.file.mimetype,
                access_token: accessToken
            }
        });

        const sessionId = initRes.data.id;
        if (!sessionId) {
            throw new Error('Failed to initialize upload session with Meta.');
        }

        // 2. Upload Data (Binary)
        const uploadUrl = `https://graph.facebook.com/v21.0/${sessionId}`;
        const uploadRes = await axios.post(uploadUrl, req.file.buffer, {
            headers: {
                'Authorization': `OAuth ${accessToken}`,
                'file_offset': '0',
                'Content-Type': req.file.mimetype
            }
        });

        if (!uploadRes.data.h) {
            throw new Error('Meta did not return a media handle (h).');
        }

        res.json({ success: true, handle: uploadRes.data.h });
    } catch (error) {
        const errData = error.response?.data || error.message;
        console.error('[Template API] Media Upload Error Details:', JSON.stringify(errData, null, 2));
        
        // Provide cleaner message for common Meta errors
        let userMsg = 'Failed to upload media to Meta';
        if (error.response?.data?.error?.message) {
            userMsg += `: ${error.response.data.error.message}`;
        }

        res.status(500).json({ 
            success: false, 
            message: userMsg, 
            details: errData 
        });
    }
});

module.exports = router;
