const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');
const log = require('../utils/logger')('TemplateAPI');
const Client = require('../models/Client');
const User = require('../models/User');

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
    if (!client.wabaId) throw new Error('WABA ID (WhatsApp Business Account ID) is not configured for this client.');
    if (!client.whatsappToken) throw new Error('WhatsApp Token is not configured for this client.');

    return client;
}

// 1. Fetch All Templates from Meta
router.get('/sync', protect, async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) return res.status(400).json({ success: false, message: 'clientId is required' });

        const client = await getClientCredentials(clientId, req.user.id);

        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/message_templates?fields=name,status,category,language,components`;
        
        try {
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${client.whatsappToken}` }
            });
            res.json({ success: true, data: response.data.data });
        } catch (metaErr) {
            console.error('[Template API] Meta Sync Error:', metaErr.response?.data || metaErr.message);
            res.status(500).json({ success: false, message: 'Failed to sync templates from Meta', details: metaErr.response?.data });
        }

    } catch (error) {
        console.error('[Template API] Error:', error.message);
        // Returning 200 with empty data array to prevent Frontend crashes when WABA ID isn't configured for new clients
        res.status(200).json({ success: false, data: [], message: error.message });
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

        // Required API parameters for Meta Template creation
        const payload = {
            name,
            language,
            category,
            components
        };

        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/message_templates`;

        try {
            const response = await axios.post(url, payload, {
                headers: { 
                    'Authorization': `Bearer ${client.whatsappToken}`,
                    'Content-Type': 'application/json'
                }
            });
            res.json({ success: true, data: response.data });
        } catch (metaErr) {
            console.error('[Template API] Meta Create Error:', metaErr.response?.data || metaErr.message);
            res.status(400).json({ success: false, message: 'Failed to create template on Meta', details: metaErr.response?.data });
        }

    } catch (error) {
        console.error('[Template API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Delete a Template from Meta
router.delete('/:name', protect, async (req, res) => {
    try {
        const { clientId } = req.query;
        const templateName = req.params.name;
        
        if (!clientId) return res.status(400).json({ success: false, message: 'clientId is required' });

        const client = await getClientCredentials(clientId, req.user.id);
        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/message_templates?name=${templateName}`;

        try {
            const response = await axios.delete(url, {
                headers: { Authorization: `Bearer ${client.whatsappToken}` }
            });
            res.json({ success: true, message: 'Template deleted successfully' });
        } catch (metaErr) {
            res.status(400).json({ success: false, message: 'Failed to delete template', details: metaErr.response?.data });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
