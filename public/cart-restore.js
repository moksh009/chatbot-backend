(function () {
    try {
        const params = new URLSearchParams(window.location.search);
        const uid = params.get('uid');
        const restore = params.get('restore');

        if (!uid || restore !== 'true') return;

        localStorage.setItem('whatsapp_uid', uid);

        restoreCart(uid);
    } catch (err) {
        console.error('Cart restore init failed', err);
    }
})();

async function restoreCart(uid) {
    try {
        // 1️⃣ Fetch cart snapshot from backend
        const res = await fetch(
            `https://chatbot-backend-lg5y.onrender.com/api/client/delitech_smarthomes/cart-snapshot?uid=${uid}`
        );
        const data = await res.json();

        if (!data || !data.cart || !data.cart.items || data.cart.items.length === 0) return;

        // 2️⃣ Clear current cart
        await fetch('/cart/clear.js', { method: 'POST' });

        // 3️⃣ Re-add items sequentially to avoid concurrency issues
        for (const item of data.cart.items) {
            await fetch('/cart/add.js', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: item.variant_id,
                    quantity: item.quantity
                })
            });
        }

        // 4️⃣ Redirect to checkout directly for higher conversion
        window.location.href = '/checkout';

    } catch (err) {
        console.error('Cart restore failed', err);
    }
}
