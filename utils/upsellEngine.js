const { GoogleGenerativeAI } = require('@google/generative-ai');
const log = require('./logger')('UpsellEngine');
const { withShopifyRetry } = require('./shopifyHelper');
const ScheduledMessage = require('../models/ScheduledMessage');

/**
 * Triggered by Shopify orders/fulfilled webhook.
 * Analyzes the order to suggest a complementary product and schedules a follow-up WhatsApp message 7 days post-fulfillment.
 * @param {Object} client The Client model instance.
 * @param {Object} orderData The Shopify webhook payload.
 */
async function schedulePostDeliveryUpsell(client, orderData) {
    try {
        const phoneRaw = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone;
        if (!phoneRaw) {
            log.info(`No phone found for order ${orderData.id}, skipping upsell.`);
            return;
        }

        const { normalizePhone } = require('./helpers');
        const phone = normalizePhone(phoneRaw);

        // Fetch a catalog subset (e.g., 10 top/recently active products)
        // We do this instead of feeding the whole catalog to Gemini to save tokens
        let catalogSubset = [];
        if (client.storeType === 'shopify') {
            catalogSubset = await withShopifyRetry(client.clientId, async (shopify) => {
                const res = await shopify.get('/products.json', { params: { limit: 10, status: 'active', fields: 'title,variants,handle,product_type' } });
                return res.data.products || [];
            });
        }

        if (!catalogSubset.length) {
            log.info(`No products available in catalog for client ${client.clientId}, skipping upsell.`);
            return;
        }

        // Format the purchased items
        const purchasedItems = orderData.line_items?.map(i => i.title).join(', ') || 'their recent order';

        // Format the available catalog
        const catalogText = catalogSubset.map(p => `- ${p.title} (${p.product_type || 'General'})`).join('\n');

        // Prepare AI Evaluation
        const apiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            log.warn(`No Gemini API key found for client ${client.clientId}. Upsell Engine disabled.`);
            return;
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { responseMimeType: 'application/json' } });

        const prompt = `You are a post-purchase personalized upsell AI for ${client.businessName}.
The customer just received: "${purchasedItems}".
Here is a sample of our active catalog:
${catalogText}

Select ONE product from the catalog that best complements what they bought. Do not choose an exact item they already purchased.
Formulate a friendly, non-pushy follow-up WhatsApp message asking how they like their recent purchase and then organically recommending the complementary product you chose.
Include the product name clearly.

Return a JSON object:
{
  "selectedProduct": "Product Name",
  "recommendedMessage": "Message body string"
}`;

        const result = await model.generateContent(prompt);
        const aiResponse = JSON.parse(result.response.text().trim());

        if (!aiResponse.recommendedMessage) {
            throw new Error('AI failed to generate a recommendation message.');
        }

        // Schedule it 7 days from now (to account for shipping time to delivery + a few days)
        const sendAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 Days
        
        await ScheduledMessage.create({
            clientId: client.clientId,
            phone: phone,
            type: 'whatsapp_text',
            content: { text: aiResponse.recommendedMessage },
            sendAt: sendAt,
            status: 'pending',
            metadata: { 
                type: 'post_purchase_upsell', 
                orderId: orderData.id, 
                orderNumber: orderData.order_number, 
                recommendedProduct: aiResponse.selectedProduct 
            }
        });

        log.info(`✅ Upsell Scheduled for ${phone} in 7 days. Suggested product: *${aiResponse.selectedProduct}*.`);
        
    } catch (err) {
        log.error(`Failed to schedule upsell for order ${orderData.id}:`, { error: err.message });
    }
}

module.exports = {
    schedulePostDeliveryUpsell
};
