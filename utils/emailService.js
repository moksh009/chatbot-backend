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
/**
 * Send a System OTP using the dedicated TopEdge AI credentials.
 */
async function sendSystemOTPEmail(toAddress, otpCode, purpose = 'SIGNUP') {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SYSTEM_EMAIL_USER,
            pass: process.env.SYSTEM_EMAIL_PASS
        }
    });

    let subject = 'TopEdge AI - Your Verification Code';
    let activityText = purpose === 'SIGNUP' ? 'verify your email address and complete registration' : 'reset your password';

    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 40px auto; padding: 32px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
            <div style="text-align: center; margin-bottom: 24px;">
                <h2 style="color: #0f172a; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em;">TopEdge AI</h2>
            </div>
            <p style="color: #475569; font-size: 15px; line-height: 1.6; margin-top: 0;">Hi there,</p>
            <p style="color: #475569; font-size: 15px; line-height: 1.6;">Use the following 6-digit code to ${activityText}. This code is valid for <strong>5 minutes</strong>.</p>
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; text-align: center; margin: 32px 0;">
                <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #6366f1;">${otpCode}</span>
            </div>
            <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-bottom: 0;">If you didn't request this code, you can safely ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 32px 0;" />
            <p style="text-align: center; color: #94a3b8; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} TopEdge AI. All rights reserved.</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"TopEdge AI Security" <${process.env.SYSTEM_EMAIL_USER}>`,
            to: toAddress,
            subject,
            html
        });
        console.log(`[EmailService] System OTP sent to ${toAddress}`);
        return true;
    } catch (err) {
        console.error(`[EmailService] ❌ Failed to send System OTP to ${toAddress}:`, err.message);
        return false;
    }
}

/**
 * Send a team invitation email to a new agent.
 */
async function sendTeamInviteEmail(toAddress, { adminName, businessName, password, loginUrl }) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SYSTEM_EMAIL_USER,
            pass: process.env.SYSTEM_EMAIL_PASS
        }
    });

    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 40px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05);">
            <div style="text-align: center; margin-bottom: 32px;">
                <h2 style="color: #6366f1; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.025em;">TopEdge AI</h2>
                <p style="color: #64748b; font-size: 14px; margin-top: 8px; font-weight: 500;">Invitation to join workspace</p>
            </div>
            
            <p style="color: #0f172a; font-size: 18px; font-weight: 600; line-height: 1.4; margin-top: 0;">You're Invited! 👋</p>
            <p style="color: #475569; font-size: 15px; line-height: 1.6;"><strong>${adminName}</strong> has invited you to join the <strong>${businessName}</strong> team on TopEdge AI.</p>
            
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; margin: 32px 0;">
                <p style="color: #64748b; font-size: 13px; margin: 0 0 12px 0; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em;">Your Login Credentials</p>
                <div style="margin-bottom: 12px;">
                    <span style="color: #475569; font-size: 14px;">Email:</span>
                    <span style="color: #0f172a; font-size: 14px; font-weight: 600; margin-left: 8px;">${toAddress}</span>
                </div>
                <div>
                    <span style="color: #475569; font-size: 14px;">Temporary Password:</span>
                    <span style="color: #6366f1; font-size: 14px; font-weight: 700; margin-left: 8px;">${password}</span>
                </div>
            </div>
            
            <div style="text-align: center;">
                <a href="${loginUrl}" style="display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">
                    Accept Invitation & Login →
                </a>
            </div>
            
            <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 32px; text-align: center;">
                For security, please change your password immediately after your first login.
            </p>
            
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 40px 0;" />
            <p style="text-align: center; color: #94a3b8; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} TopEdge AI. Enterprise Team Operations Layer.</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"TopEdge AI" <${process.env.SYSTEM_EMAIL_USER}>`,
            to: toAddress,
            subject: `👋 You've been invited to join ${businessName} on TopEdge AI`,
            html
        });
        return true;
    } catch (err) {
        console.error(`[EmailService] ❌ Failed to send Team Invite to ${toAddress}:`, err.message);
        return false;
    }
}

/**
 * Send an admin confirmation email when a new member is invited.
 */
async function sendAdminConfirmationEmail(adminEmail, { agentName, agentEmail, businessName }) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SYSTEM_EMAIL_USER,
            pass: process.env.SYSTEM_EMAIL_PASS
        }
    });

    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 40px auto; padding: 32px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
            <div style="text-align: center; margin-bottom: 24px;">
                <h2 style="color: #0f172a; margin: 0; font-size: 20px; font-weight: 700;">TopEdge AI Admin</h2>
            </div>
            <p style="color: #475569; font-size: 15px; line-height: 1.6;">Invitation sent successfully! 🚀</p>
            <p style="color: #475569; font-size: 15px; line-height: 1.6;">
                You have successfully invited <strong>${agentName}</strong> (${agentEmail}) to join the <strong>${businessName}</strong> workspace.
            </p>
            <p style="color: #64748b; font-size: 14px; margin-top: 24px;">
                They will appear in your Team Directory once they accept the invitation.
            </p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
            <p style="text-align: center; color: #94a3b8; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} TopEdge AI.</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"TopEdge AI" <${process.env.SYSTEM_EMAIL_USER}>`,
            to: adminEmail,
            subject: `✅ Invitation Sent: ${agentName} has been invited`,
            html
        });
        return true;
    } catch (err) {
        console.error(`[EmailService] ❌ Failed to send Admin Confirmation:`, err.message);
        return false;
    }
}

module.exports = {
    sendEmail,
    sendAbandonedCartEmail,
    sendOrderConfirmationEmail,
    sendCODToPrepaidEmail,
    sendSystemOTPEmail,
    sendTeamInviteEmail,
    sendAdminConfirmationEmail
};
