const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');
const { resolveClientGeminiKey } = require('../utils/clientGeminiKey');

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
      const isWebhookPath =
        String(req.originalUrl || '').includes('/webhook/');
      // Quietly acknowledge stale legacy webhook hits from deprecated client IDs.
      // This prevents noisy logs/retries while we are fully e-commerce-only.
      if (isWebhookPath) {
        return res.status(200).json({ success: true, ignored: true, reason: 'unknown_client_webhook' });
      }
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

    // === Gemini (tenant bot AI) — DB only; never promote server GEMINI_API_KEY onto webhooks ===
    const resolvedGeminiKey = resolveClientGeminiKey(client);

    if (!finalToken) {
      console.warn(`[ClientConfig] ⚠️ No WhatsApp token found for client: ${clientId}`);
    }
    if (!resolvedGeminiKey) {
      console.warn(
        `[ClientConfig] No Gemini API key on Client ${clientId} — WhatsApp AI fallback / translations use the merchant key only. Add one under client AI settings.`
      );
    }

    const waVerify =
      (client.whatsapp && String(client.whatsapp.verifyToken || '').trim()) || '';
    const rootVerify = String(client.verifyToken || '').trim();
    const resolvedVerifyToken =
      process.env[`VERIFY_TOKEN${envSuffix}`] ||
      waVerify ||
      rootVerify ||
      process.env.VERIFY_TOKEN ||
      process.env.WHATSAPP_VERIFY_TOKEN;

    req.clientConfig = {
      _id: client._id,
      clientId: client.clientId,
      name: client.name,
      businessType: client.businessType || 'other',
      phoneNumberId: client.phoneNumberId,
      // Add phone number for message direction logic (incoming vs outgoing)
      phoneNumber: client.config?.phoneNumber || process.env[`PHONE_NUMBER${envSuffix}`] || process.env.PHONE_NUMBER,
      adminPhoneNumber: client.adminPhone || client.adminPhoneNumber || client.config?.adminPhoneNumber || process.env[`ADMIN_PHONE_NUMBER${envSuffix}`] || process.env.ADMIN_PHONE_NUMBER,

      // Use the resolved finalToken, ensuring it is decrypted if stored in encrypted format
      whatsappToken: decrypt(finalToken),
      verifyToken: resolvedVerifyToken,
      googleCalendarId: client.googleCalendarId || process.env[`GOOGLE_CALENDAR_ID${envSuffix}`] || process.env.GOOGLE_CALENDAR_ID,
      
      // Phase 13: Deprecating OpenAI name in config
      geminiApiKey: resolvedGeminiKey,
      
      // Legacy aliases for backward compatibility during transition
      openaiApiKey: resolvedGeminiKey, 
      geminiApikey: resolvedGeminiKey,
      config: client.config || {},
      
      // === NEW SAAS ARCHITECTURE FIELDS ===
      nicheData: client.nicheData || {},
      platformVars: client.platformVars || {},
      flowData: client.flowData || {},
      automationFlows: client.automationFlows || [],
      messageTemplates: client.messageTemplates || [],
      syncedMetaTemplates: client.syncedMetaTemplates || [],
      flowNodes: client.flowNodes || [],
      flowEdges: client.flowEdges || [],
      
      // Phase 7 Credentials & URLs
      adminPhone: client.adminPhone || '',
      shopDomain: client.shopDomain || '',
      shopifyAccessToken: client.shopifyAccessToken || '',
      shopifyStorefrontToken: client.shopifyStorefrontToken || '',
      facebookCatalogId: client.facebookCatalogId || '',
      hasMetaCatalogAccessToken: !!String(client.metaCatalogAccessToken || '').trim(),
      waCatalogId: client.waCatalogId || '',
      metaCatalogId: client.metaCatalogId || '',
      commerceBotSettings: client.commerceBotSettings || {},
      wabaId: client.wabaId || '',
      razorpayKeyId: client.razorpayKeyId || '',
      razorpaySecret: client.razorpaySecret || '',
      googleReviewUrl: client.googleReviewUrl || '',

      plan: client.plan || 'CX Agent (V1)',
      isGenericBot: client.isGenericBot || false,
      subscriptionPlan: client.subscriptionPlan || 'v2',
      isActive: client.isActive !== false // Default to true unless explicitly false
    };

    next();

  } catch (error) {
    console.error('Error loading client config:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = loadClientConfig;
