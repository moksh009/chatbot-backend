import { register } from '@shopify/web-pixels-extension';

/**
 * TopEdge Deep Pixel — runs on storefront + Shopify Checkout (Web Pixels API).
 * Settings (clientId, apiBaseUrl) are injected via Admin API webPixelCreate/update.
 */
register(({ analytics, settings }) => {
  const clientId = settings && settings.clientId;
  const apiBaseUrl = settings && settings.apiBaseUrl
    ? String(settings.apiBaseUrl).replace(/\/+$/, '')
    : '';
  if (!clientId || !apiBaseUrl) return;

  const endpoint = `${apiBaseUrl}/api/shopify-pixel/pixel/${clientId}/event`;

  function send(eventName, data) {
    const payload = {
      eventName,
      metadata: Object.assign({}, data || {}, { source: 'shopify_web_pixel_extension' }),
      timestamp: new Date().toISOString(),
    };
    if (data && data.shopifyClientId) payload.shopifyClientId = data.shopifyClientId;
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  }

  analytics.subscribe('checkout_contact_info_submitted', (event) => {
    const checkout = event.data && event.data.checkout;
    if (!checkout) return;
    const lineItems = (checkout.lineItems || []).map((li) => {
      const v = li.variant || li.merchandise || {};
      const p = v.product || {};
      return {
        title: p.title || v.title || 'Item',
        variantId: v.id,
        productId: p.id,
        quantity: li.quantity || 1,
        price: v.price && v.price.amount,
      };
    });
    send('checkout_contact_identified', {
      email: checkout.email,
      phone: checkout.phone,
      checkoutToken: checkout.token,
      checkoutUrl: checkout.webUrl,
      cartTotal: checkout.totalPrice && checkout.totalPrice.amount,
      cartItems: lineItems,
      shopifyClientId: event.clientId,
      captureMode: 'web_pixel_on_submit',
    });
  });

  analytics.subscribe('checkout_address_info_submitted', (event) => {
    const checkout = event.data && event.data.checkout;
    if (!checkout) return;
    send('checkout_contact_identified', {
      email: checkout.email,
      phone: checkout.phone,
      checkoutToken: checkout.token,
      checkoutUrl: checkout.webUrl,
      cartTotal: checkout.totalPrice && checkout.totalPrice.amount,
      shopifyClientId: event.clientId,
      captureMode: 'web_pixel_address_submit',
    });
  });

  analytics.subscribe('checkout_started', (event) => {
    const c = event.data && event.data.checkout;
    if (!c) return;
    send('checkout_started', {
      checkoutToken: c.token,
      cartTotal: c.totalPrice && c.totalPrice.amount,
      shopifyClientId: event.clientId,
    });
  });

  analytics.subscribe('checkout_completed', (event) => {
    const c = event.data && event.data.checkout;
    if (!c) return;
    send('checkout_completed', {
      checkoutToken: c.token,
      orderId: c.order && c.order.id,
      email: c.email,
      phone: c.phone,
      cartTotal: c.totalPrice && c.totalPrice.amount,
      shopifyClientId: event.clientId,
    });
  });

  analytics.subscribe('product_added_to_cart', (event) => {
    const line = event.data && event.data.cartLine;
    if (!line) return;
    const merch = line.merchandise || {};
    const prod = merch.product || {};
    send('product_added_to_cart', {
      product: {
        title: prod.title,
        id: prod.id,
        price: merch.price && merch.price.amount,
      },
      shopifyClientId: event.clientId,
    });
  });

  analytics.subscribe('page_viewed', (event) => {
    send('page_view', {
      url:
        event.context &&
        event.context.document &&
        event.context.document.location &&
        event.context.document.location.href,
      shopifyClientId: event.clientId,
    });
  });
});
