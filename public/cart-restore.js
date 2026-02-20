(function () {
    try {
        const params = new URLSearchParams(window.location.search);
        const uid = params.get('uid');
        const restore = params.get('restore');

        if (uid) {
            localStorage.setItem('whatsapp_uid', uid);
        }

        if (uid && restore === 'true') {
            restoreCart(uid);
        }
    } catch (err) {
        console.error('Cart restore init failed', err);
    }
})();

async function logRestoreFailed(uid, details) {
    try {
        await fetch('https://chatbot-backend-lg5y.onrender.com/api/client/delitech_smarthomes/webhook/shopify/log-restore-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid, action: 'restore_failed', details })
        });
    } catch (e) {
        console.error('Failed to log restore error', e);
    }
}

async function restoreCart(uid) {
    try {
        // 1️⃣ Fetch cart snapshot from backend
        const res = await fetch(
            `https://chatbot-backend-lg5y.onrender.com/api/client/delitech_smarthomes/cart-snapshot?uid=${uid}`
        );

        if (!res.ok) {
            console.warn('Cart restore failed: Snapshot API returned ' + res.status);
            await logRestoreFailed(uid, `Snapshot API error: ${res.status}`);
            return;
        }

        const data = await res.json();

        if (!data || !data.cart || !data.cart.items || data.cart.items.length === 0) {
            console.warn('Cart restore failed: Snapshot empty');
            await logRestoreFailed(uid, 'Cart snapshot is empty');
            return;
        }

        // 2️⃣ Clear current cart
        await fetch('/cart/clear.js', { method: 'POST' });

        // 3️⃣ Re-add items sequentially to avoid concurrency issues
        let allAdded = true;
        for (const item of data.cart.items) {
            try {
                const addRes = await fetch('/cart/add.js', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: item.variant_id,
                        quantity: item.quantity
                    })
                });
                if (!addRes.ok) {
                    console.warn(`Failed to add variant ${item.variant_id} to cart`);
                    allAdded = false;
                }
            } catch (addErr) {
                console.warn(`Error adding variant ${item.variant_id} to cart`, addErr);
                allAdded = false;
            }
        }

        if (!allAdded) {
            await logRestoreFailed(uid, 'Failed to add one or more items to cart');
            return; // Never redirect to checkout if rebuild fails
        }

        // 4️⃣ Redirect to checkout directly for higher conversion
        window.location.href = '/checkout';

    } catch (err) {
        console.error('Cart restore failed', err);
        await logRestoreFailed(uid, err.message || 'Unknown network error during restore');
    }
}
