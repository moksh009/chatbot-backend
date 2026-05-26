'use strict';

const THIRD_PARTY_IDS = new Set([
  'gokwik',
  'razorpay_magic',
  'shiprocket',
  'other_third_party',
]);

/**
 * Which canonical source ids to show for a Shopify merchant stack.
 */
function visibleSourceIds(stack) {
  const platform = stack?.storePlatform || 'none';
  const checkout =
    stack?.thirdPartyCheckout?.detected ||
    stack?.audienceContext?.thirdPartyCheckout ||
    'unknown';

  const isThirdParty = THIRD_PARTY_IDS.has(checkout);
  const shopify = platform === 'shopify' && stack?.shopifyDetails?.connected;

  const ids = [];

  if (shopify && !isThirdParty) {
    ids.push('shopify_checkout');
  }
  if (isThirdParty || checkout === 'unknown' || checkout === 'not_sure') {
    if (shopify || isThirdParty) ids.push('third_party_checkout');
  }

  ids.push('website_widgets', 'whatsapp_keyword', 'click_to_whatsapp_ads', 'manual_import');

  if (shopify) ids.push('shopify_migration');
  ids.push('qr_offline');

  return [...new Set(ids)];
}

module.exports = { visibleSourceIds, THIRD_PARTY_IDS };
