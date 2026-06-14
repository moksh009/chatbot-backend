import React, { useEffect, useRef, useState } from 'react';
import {
  reactExtension,
  useApi,
  useShippingAddress,
  useEmail,
  usePhone,
  useCartLines,
  useTotalAmount,
  useCheckoutToken,
} from '@shopify/ui-extensions-react/checkout';

/**
 * Real-time checkout identity capture (300ms debounce while typing).
 * Fires as soon as valid email OR 10-digit phone is present — no Continue click required.
 */

export default reactExtension(
  'purchase.checkout.delivery-address.render-after',
  () => <DeliveryStepCapture />,
);

export const contactCapture = reactExtension(
  'purchase.checkout.contact.render-after',
  () => <ContactStepCapture />,
);

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildCartPayload(cartLines, totalAmount) {
  const items = (cartLines || []).map((line) => ({
    title: line.merchandise?.title || line.title || '',
    productTitle: line.merchandise?.product?.title || '',
    variant_id: line.merchandise?.id || '',
    quantity: line.quantity || 1,
    price: line.cost?.totalAmount?.amount || 0,
    image: line.merchandise?.image?.url || '',
  }));

  return {
    items,
    itemCount: items.reduce((s, i) => s + (i.quantity || 1), 0),
    cartTotal: totalAmount?.amount || 0,
    currency: totalAmount?.currencyCode || 'INR',
  };
}

function ContactStepCapture() {
  const email = useEmail();
  const phone = usePhone();
  return (
    <LiveCaptureCore
      captureTarget="contact_info"
      resolvedEmail={String(email || '').trim()}
      resolvedPhone={digitsOnly(phone || '')}
    />
  );
}

function DeliveryStepCapture() {
  const shippingAddress = useShippingAddress();
  return (
    <LiveCaptureCore
      captureTarget="delivery_address"
      resolvedEmail={String(shippingAddress?.email || '').trim()}
      resolvedPhone={digitsOnly(shippingAddress?.phone || '')}
    />
  );
}

function LiveCaptureCore({ captureTarget, resolvedEmail, resolvedPhone }) {
  const { shop } = useApi();
  const checkoutToken = useCheckoutToken();
  const cartLines = useCartLines();
  const totalAmount = useTotalAmount();

  const [config, setConfig] = useState(null);
  const lastSentRef = useRef('');
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const shopDomain =
      shop?.myshopifyDomain || shop?.domain || shop?.storefrontUrl || '';
    if (!shopDomain) return undefined;

    const configUrl = `https://api.topedgeai.com/api/public/checkout-capture/config?shop=${encodeURIComponent(
      shopDomain,
    )}`;

    fetch(configUrl)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.success && data?.enabled) {
          setConfig(data);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [shop]);

  const hasValidPhone = resolvedPhone.length >= 10;
  const hasValidEmail = resolvedEmail.includes('@') && resolvedEmail.length > 5;
  const identityKey = `${resolvedEmail.toLowerCase()}|${resolvedPhone}`;

  useEffect(() => {
    if (!config?.apiBaseUrl || !config?.clientId) return undefined;
    if (!hasValidPhone && !hasValidEmail) return undefined;
    if (lastSentRef.current === identityKey) return undefined;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const cart = buildCartPayload(cartLines, totalAmount);
      const endpoint = `${config.apiBaseUrl}/api/shopify-pixel/pixel/${config.clientId}/event`;

      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName: 'checkout_contact_identified',
          email: hasValidEmail ? resolvedEmail : undefined,
          phone: hasValidPhone ? resolvedPhone : undefined,
          metadata: {
            email: hasValidEmail ? resolvedEmail : undefined,
            phone: hasValidPhone ? resolvedPhone : undefined,
            checkoutToken: checkoutToken || '',
            captureMode: 'live_ui_extension',
            captureTarget,
            source: 'checkout_ui_capture',
            hasCartContext: cart.items.length > 0,
            cartItems: cart.items,
            cartTotal: cart.cartTotal,
            cartCurrency: cart.currency,
            cartItemCount: cart.itemCount,
          },
          timestamp: new Date().toISOString(),
        }),
        keepalive: true,
      })
        .then(() => {
          lastSentRef.current = identityKey;
        })
        .catch(() => {});
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [
    config,
    identityKey,
    hasValidPhone,
    hasValidEmail,
    resolvedEmail,
    resolvedPhone,
    checkoutToken,
    cartLines,
    totalAmount,
    captureTarget,
  ]);

  return null;
}
