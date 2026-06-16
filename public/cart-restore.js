(function () {
  const scriptEl = document.currentScript;
  const CLIENT_ID =
    (scriptEl && scriptEl.getAttribute('data-client-id')) ||
    window.__TOPEDGE_CLIENT_ID__ ||
    '';
  const API_BASE = (
    (scriptEl && scriptEl.getAttribute('data-api-base')) ||
    window.__TOPEDGE_API_BASE__ ||
    'https://api.topedgeai.com'
  ).replace(/\/$/, '');

  if (!CLIENT_ID) {
    console.warn('[TopEdge] cart-restore.js: missing data-client-id on script tag');
    return;
  }

  const clientApi = API_BASE + '/api/client/' + encodeURIComponent(CLIENT_ID);

  try {
    const params = new URLSearchParams(window.location.search);
    const uid = params.get('uid');
    const restore = params.get('restore');

    if (uid) {
      localStorage.setItem('whatsapp_uid', uid);
    }

    if (uid && restore === 'true') {
      restoreCart(uid, clientApi);
    }
  } catch (err) {
    console.error('Cart restore init failed', err);
  }

  async function logRestoreFailed(uid, details, apiRoot) {
    try {
      await fetch(apiRoot + '/webhook/shopify/log-restore-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, action: 'restore_failed', details }),
      });
    } catch (e) {
      console.error('Failed to log restore error', e);
    }
  }

  async function restoreCart(uid, apiRoot) {
    try {
      const res = await fetch(apiRoot + '/cart-snapshot?uid=' + encodeURIComponent(uid));

      if (!res.ok) {
        console.warn('Cart restore failed: Snapshot API returned ' + res.status);
        await logRestoreFailed(uid, 'Snapshot API error: ' + res.status, apiRoot);
        return;
      }

      const data = await res.json();

      if (!data || !data.cart || !data.cart.items || data.cart.items.length === 0) {
        console.warn('Cart restore failed: Snapshot empty');
        await logRestoreFailed(uid, 'Cart snapshot is empty', apiRoot);
        return;
      }

      await fetch('/cart/clear.js', { method: 'POST' });

      let allAdded = true;
      for (const item of data.cart.items) {
        try {
          const addRes = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: item.variant_id,
              quantity: item.quantity,
            }),
          });
          if (!addRes.ok) {
            console.warn('Failed to add variant ' + item.variant_id + ' to cart');
            allAdded = false;
          }
        } catch (addErr) {
          console.warn('Error adding variant ' + item.variant_id + ' to cart', addErr);
          allAdded = false;
        }
      }

      if (!allAdded) {
        await logRestoreFailed(uid, 'Failed to add one or more items to cart', apiRoot);
        return;
      }

      window.location.href = '/checkout';
    } catch (err) {
      console.error('Cart restore failed', err);
      await logRestoreFailed(uid, err.message || 'Unknown network error during restore', apiRoot);
    }
  }
})();
