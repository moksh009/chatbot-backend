/**
 * Utility to inject dynamic lead/order variables into message strings.
 * Used for personalization in WhatsApp templates and interactive messages.
 */
function injectVariables(text, { lead, client, order }) {
  if (!text) return "";

  let result = text;

  // 1. Lead Variables
  if (lead) {
    result = result.replace(/{{name}}/g, lead.name || "Customer");
    result = result.replace(/{{first_name}}/g, lead.name?.split(" ")[0] || "Customer");
    result = result.replace(/{{phone}}/g, lead.phoneNumber || "");
    
    // Dynamic Buy URLs with UTMs
    if (client?.nicheData?.storeUrl) {
      const baseUrl = client.nicheData.storeUrl;
      result = result.replace(/{{buy_url_5mp}}/g, `${baseUrl}/products/delitech-smart-wireless-video-doorbell-5mp?utm_source=whatsapp&utm_medium=chatbot&uid=${lead._id}`);
      result = result.replace(/{{buy_url_3mp}}/g, `${baseUrl}/products/delitech-smart-wireless-video-doorbell-3mp?utm_source=whatsapp&utm_medium=chatbot&uid=${lead._id}`);
      result = result.replace(/{{buy_url_2mp}}/g, `${baseUrl}/products/delitech-smart-wireless-video-doorbell-2mp?utm_source=whatsapp&utm_medium=chatbot&uid=${lead._id}`);
      result = result.replace(/{{cart_url}}/g, `${baseUrl}/cart?uid=${lead._id}`);
    }
  }

  // 2. Client Variables
  if (client) {
    result = result.replace(/{{business_name}}/g, client.businessName || "Delitech Smart Homes");
  }

  // 3. Order Variables (for COD Nudges / Status)
  if (order) {
    result = result.replace(/{{order_id}}/g, order.orderId || "");
    result = result.replace(/{{amount}}/g, order.amount?.toLocaleString() || "0");
  }

  return result;
}

module.exports = { injectVariables };
