import React, { useEffect, useState } from 'react';
import {
  reactExtension,
  BlockStack,
  Checkbox,
  Text,
  useApi,
  useBuyerJourneyIntercept,
  useShippingAddress,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension('purchase.checkout.contact.render-after', () => (
  <TopEdgeCheckoutConsent />
));

function TopEdgeCheckoutConsent() {
  const { shop } = useApi();
  const shippingAddress = useShippingAddress();
  const [config, setConfig] = useState(null);
  const [checked, setChecked] = useState(true);
  const [posted, setPosted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const shopDomain =
      shop?.myshopifyDomain || shop?.domain || shop?.storefrontUrl || '';
    if (!shopDomain) return;

    const configUrl = `https://api.topedgeai.com/api/public/checkout-consent/config?shop=${encodeURIComponent(
      shopDomain
    )}`;

    fetch(configUrl)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.success || !data?.enabled) return;
        setConfig(data);
        setChecked(data.defaultChecked !== false);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [shop]);

  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (!canBlockProgress) return { behavior: 'allow' };
    return { behavior: 'allow' };
  });

  useEffect(() => {
    if (!config?.apiBaseUrl || !checked || posted) return;
    const phone = shippingAddress?.phone;
    if (!phone) return;

    const timer = setTimeout(() => {
      fetch(`${config.apiBaseUrl}/api/public/checkout-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop: shop?.myshopifyDomain || shop?.domain,
          clientId: config.clientId,
          embedKey: config.embedKey,
          phone,
          marketingOptIn: true,
          source: 'checkout_ui_extension',
        }),
      })
        .then(() => setPosted(true))
        .catch(() => {});
    }, 400);

    return () => clearTimeout(timer);
  }, [checked, config, shippingAddress?.phone, posted, shop]);

  if (!config?.consentText) return null;

  return (
    <BlockStack spacing="tight">
      <Checkbox checked={checked} onChange={setChecked}>
        <Text size="small">{config.consentText}</Text>
      </Checkbox>
    </BlockStack>
  );
}
