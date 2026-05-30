const log = require('../core/logger')('UpsellEngine');
const { withShopifyRetry } = require('../shopify/shopifyHelper');
const { callAIJSON } = require('../core/aiGateway');

async function schedulePostDeliveryUpsell(client, orderData) {
  try {
    const phoneRaw = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone;
    if (!phoneRaw) {
      log.info(`No phone found for order ${orderData.id}, skipping upsell.`);
      return;
    }

    const { normalizePhone } = require('../core/helpers');
    const phone = normalizePhone(phoneRaw);

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

    const purchasedItems = orderData.line_items?.map((i) => i.title).join(', ') || 'their recent order';
    const catalogText = catalogSubset.map((p) => `- ${p.title} (${p.product_type || 'General'})`).join('\n');

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

    const result = await callAIJSON({
      clientId: client.clientId,
      feature: 'other',
      prompt,
      maxTokens: 600,
      fast: false,
    });
    const aiResponse = result.data;

    if (!aiResponse?.recommendedMessage) {
      throw new Error('AI failed to generate a recommendation message.');
    }

    const sendAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { scheduleOutboundMessage } = require('./scheduleOutboundMessage');
    await scheduleOutboundMessage({
      clientId: client.clientId,
      phone,
      message: aiResponse.recommendedMessage,
      sendAt,
      metadata: { type: 'post_delivery_upsell', product: aiResponse.selectedProduct },
    });

    log.info(`Scheduled post-delivery upsell for ${phone} at ${sendAt.toISOString()}`);
  } catch (err) {
    if (err.code !== 'AI_NOT_CONFIGURED') {
      log.error('UpsellEngine error:', err.message);
    }
  }
}

module.exports = { schedulePostDeliveryUpsell };
