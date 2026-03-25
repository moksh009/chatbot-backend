const Client = require('../models/Client');

/**
 * Middleware to load client configuration based on route parameter 'clientId'
 */
const loadClientConfig = async (req, res, next) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ error: 'Client ID is required' });
    }

    const client = await Client.findOne({ clientId });

    if (!client) {
      console.warn(`⚠️  ClientConfig: Client not found for ID '${clientId}'`);
      return res.status(404).json({ error: 'Client not found' });
    }

    // console.log(`🔍 ClientConfig loaded for: ${clientId} (${client.businessType})`);

    // Attach client config to request
    // Allow overriding via environment variables for specific clients (e.g. WHATSAPP_TOKEN_0001)
    const envSuffix = `_${client.clientId}`;

    // Check if token exists in env
    const envToken = process.env[`WHATSAPP_TOKEN${envSuffix}`];
    const clientToken = client.whatsappToken;
    const clientConfigToken = client.config?.whatsappToken; // Check nested config just in case
    const globalToken = process.env.WHATSAPP_TOKEN;

    // Determine token source (Priority: DB > Env > Global)
    // User explicitly requested to prioritize MongoDB and ignore expired Env
    let finalToken = clientToken || clientConfigToken;

    if (!finalToken) {
      if (envToken) {
        finalToken = envToken;
        console.log(`⚠️ Using ENV token for ${clientId} (DB token missing)`);
      } else if (globalToken) {
        finalToken = globalToken;
        console.log(`⚠️ Using GLOBAL token for ${clientId} (DB & Specific Env missing)`);
      }
    }

    // === Resolve Gemini API Key === 
    const rawDbGeminiKey = client.openaiApiKey ? client.openaiApiKey.trim() : null;
    const rawEnvGeminiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    const resolvedGeminiKey = rawDbGeminiKey || rawEnvGeminiKey || null;

    if (!finalToken) {
      console.warn(`[ClientConfig] ⚠️ No WhatsApp token found for client: ${clientId}`);
    }
    if (!resolvedGeminiKey) {
      console.warn(`[ClientConfig] ⚠️ No Gemini API key found for client: ${clientId}`);
    }

    req.clientConfig = {
      _id: client._id,
      clientId: client.clientId,
      name: client.name,
      businessType: client.businessType || 'other',
      phoneNumberId: client.phoneNumberId,
      // Add phone number for message direction logic (incoming vs outgoing)
      phoneNumber: client.config?.phoneNumber || process.env[`PHONE_NUMBER${envSuffix}`] || process.env.PHONE_NUMBER,
      adminPhoneNumber: client.adminPhoneNumber || client.config?.adminPhoneNumber || process.env[`ADMIN_PHONE_NUMBER${envSuffix}`] || process.env.ADMIN_PHONE_NUMBER,

      // Use the resolved finalToken
      whatsappToken: finalToken,
      verifyToken: process.env[`VERIFY_TOKEN${envSuffix}`] || client.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN,
      googleCalendarId: client.googleCalendarId || process.env[`GOOGLE_CALENDAR_ID${envSuffix}`] || process.env.GOOGLE_CALENDAR_ID,
      openaiApiKey: client.openaiApiKey || process.env[`OPENAI_API_KEY${envSuffix}`] || process.env.OPENAI_API_KEY,
      // Dedicated Gemini key (trimmed to remove invisible leading/trailing spaces)
      geminiApiKey: resolvedGeminiKey,
      // Legacy alias used by choice_salon / choice_salon_holi
      geminiApikey: resolvedGeminiKey,
      config: client.config || {},
      
      // === NEW SAAS ARCHITECTURE FIELDS ===
      nicheData: client.nicheData || {},
      flowData: client.flowData || {},
      plan: client.plan || 'CX Agent (V1)',
      isGenericBot: client.isGenericBot || false,
      subscriptionPlan: client.subscriptionPlan || 'v2'
    };

    next();

  } catch (error) {
    console.error('Error loading client config:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = loadClientConfig;
