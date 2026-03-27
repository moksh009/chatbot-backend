const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');

// Middleware to verify client access
const verifyClientAccess = (req, res, next) => {
  const { clientId } = req.params;
  if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// POST /api/shopify/:clientId/connect
// This handles the "Client Credentials Grant" which is the only way to get a token 
// for new Shopify Custom Apps (2026 flow) without a visible token in the UI.
router.post('/:clientId/connect', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { shopDomain, shopifyClientId, shopifyClientSecret } = req.body;

    if (!shopDomain || !shopifyClientId || !shopifyClientSecret) {
      return res.status(400).json({ success: false, message: 'Missing required credentials' });
    }

    // Clean shop domain (ensure it's just 'shopname.myshopify.com')
    const cleanShopDomain = shopDomain
      .replace('https://', '')
      .replace('http://', '')
      .split('/')[0];

    console.log(`🔄 Attempting Shopify token exchange for ${cleanShopDomain}...`);

    // Shopify Token Exchange (Client Credentials Grant)
    const url = `https://${cleanShopDomain}/admin/oauth/access_token`;

    const response = await axios.post(url, {
      client_id: shopifyClientId,
      client_secret: shopifyClientSecret,
      grant_type: 'client_credentials'
    });

    const { access_token, scope } = response.data;

    if (!access_token) {
      throw new Error('No access token received from Shopify');
    }

    // Update Client in DB
    await Client.findOneAndUpdate(
      { clientId },
      { 
        $set: { 
          shopifyAccessToken: access_token,
          shopifyClientId,
          shopifyClientSecret,
          shopDomain: cleanShopDomain
        } 
      }
    );

    console.log(`✅ Shopify connected for ${clientId}. Scopes: ${scope}`);

    res.json({ 
      success: true, 
      message: 'Shopify connected successfully!',
      shopifyAccessToken: access_token,
      scope
    });

  } catch (error) {
    console.error('❌ Shopify Connection Error:', error.response?.data || error.message);
    
    let errorMessage = 'Failed to connect to Shopify. Please verify your Client ID and Secret.';
    if (error.response?.data?.error === 'invalid_client') {
       errorMessage = 'Invalid Client ID or Secret. Please double-check them in Shopify Dev Dashboard.';
    }

    res.status(500).json({ 
      success: false, 
      message: errorMessage,
      details: error.response?.data || error.message
    });
  }
});

module.exports = router;
