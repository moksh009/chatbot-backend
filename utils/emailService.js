const nodemailer = require('nodemailer');

/**
 * Create a nodemailer transporter from client's stored email credentials.
 * Falls back to global env vars if client-specific ones are not set.
 */
function createTransporter(client) {
    const emailUser = client.emailUser || process.env.EMAIL_USER;
    const emailPass = client.emailAppPassword || process.env.EMAIL_APP_PASSWORD;

    if (!emailUser || !emailPass) {
        console.warn(`[EmailService] No email credentials for client: ${client.clientId}`);
        return null;
    }

    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });
}

/**
 * Send an email to a customer.
 * @param {Object} client - The full client DB document
 * @param {Object} options - { to, subject, html }
 */
async function sendEmail(client, { to, subject, html }) {
    if (!to) {
        console.warn('[EmailService] Skipped send — no recipient email.');
        return false;
    }

    const transporter = createTransporter(client);
    if (!transporter) return false;

    try {
        const from = `"${client.name || 'Store'}" <${client.emailUser || process.env.EMAIL_USER}>`;
        await transporter.sendMail({ from, to, subject, html });
        console.log(`[EmailService] ✅ Email sent to ${to} | Subject: ${subject}`);
        return true;
    } catch (err) {
        console.error(`[EmailService] ❌ Failed to send email to ${to}:`, err.message);
        return false;
    }
}

/**
 * Send an abandoned cart recovery email.
 */
async function sendAbandonedCartEmail(client, { customerEmail, customerName, cartLink, items }) {
    const itemsList = Array.isArray(items) && items.length
        ? items.map(i => `<li>${i.name || i.title} (x${i.quantity || 1}) — ₹${i.price || ''}</li>`).join('')
        : '<li>Your selected items</li>';

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
            <h2 style="color: #1a1a2e;">Hey ${customerName || 'there'}, you left something behind! 🛒</h2>
            <p style="color: #555;">We noticed you added items to your cart but didn't complete your purchase.</p>
            <ul style="color: #333;">${itemsList}</ul>
            <p style="color: #555;">Your cart is saved! Complete your order before it expires.</p>
            <a href="${cartLink}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #6d28d9; color: white; border-radius: 8px; text-decoration: none; font-weight: bold;">
                Complete My Order →
            </a>
            <p style="color: #aaa; font-size: 12px; margin-top: 24px;">— ${client.name || 'The Team'}</p>
        </div>
    `;

    return sendEmail(client, {
        to: customerEmail,
        subject: `${customerName ? customerName + ', your' : 'Your'} cart is waiting! 🛒`,
        html
    });
}

/**
 * Send an order confirmation email (COD or Prepaid).
 */
async function sendOrderConfirmationEmail(client, { customerEmail, customerName, orderId, orderNumber, items, totalPrice, paymentMethod }) {
    const itemsList = Array.isArray(items)
        ? items.map(i => `<li>${i}</li>`).join('')
        : `<li>${items || 'Your items'}</li>`;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
            <h2 style="color: #065f46;">🎉 Order Confirmed!</h2>
            <p style="color: #555;">Hi <strong>${customerName || 'Customer'}</strong>, thanks for your purchase from <strong>${client.name || 'our store'}</strong>!</p>
            <h3 style="color: #1a1a2e;">Order Summary</h3>
            <ul style="color: #333;">${itemsList}</ul>
            <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 8px; color: #555;">Order ID</td><td style="padding: 8px; font-weight: bold;">${orderNumber || orderId}</td></tr>
                <tr><td style="padding: 8px; color: #555;">Total</td><td style="padding: 8px; font-weight: bold;">₹${totalPrice}</td></tr>
                <tr><td style="padding: 8px; color: #555;">Payment</td><td style="padding: 8px; font-weight: bold;">${paymentMethod}</td></tr>
            </table>
            <p style="color: #555; margin-top: 16px;">We'll notify you once it ships. Thank you! 🙏</p>
            <p style="color: #aaa; font-size: 12px; margin-top: 24px;">— ${client.name || 'The Team'}</p>
        </div>
    `;

    return sendEmail(client, {
        to: customerEmail,
        subject: `Your order ${orderNumber || orderId} is confirmed ✅ — ${client.name || 'Store'}`,
        html
    });
}

/**
 * Send a COD → Prepaid conversion email nudge.
 */
async function sendCODToPrepaidEmail(client, { customerEmail, customerName, orderId, totalPrice, paymentLink }) {
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
            <h2 style="color: #1a1a2e;">💳 Save on Your Order!</h2>
            <p style="color: #555;">Hi <strong>${customerName || 'there'}</strong>! Your order <strong>${orderId}</strong> of ₹${totalPrice} is confirmed as Cash on Delivery.</p>
            <p style="color: #555; margin-top: 12px;">🎁 <strong>Pay online right now and get:</strong></p>
            <ul style="color: #333;">
                <li>✅ ₹50 instant cashback</li>
                <li>✅ Priority shipping</li>
            </ul>
            <p style="color: #e11d48;">⏰ Offer expires in 2 hours!</p>
            ${paymentLink ? `<a href="${paymentLink}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #6d28d9; color: white; border-radius: 8px; text-decoration: none; font-weight: bold;">Pay via UPI Now →</a>` : ''}
            <p style="color: #aaa; font-size: 12px; margin-top: 24px;">— ${client.name || 'The Team'}</p>
        </div>
    `;

    return sendEmail(client, {
        to: customerEmail,
        subject: `💳 Pay online for order ${orderId} and save ₹50!`,
        html
    });
}

module.exports = {
    sendEmail,
    sendAbandonedCartEmail,
    sendOrderConfirmationEmail,
    sendCODToPrepaidEmail
};
