const nodemailer = require('nodemailer');
const { decrypt } = require('./encryption');

/**
 * Credentials used for OTP, team invites, and other system mail (Render-friendly TLS).
 */
function getSystemEmailCredentials() {
    const user =
        process.env.SYSTEM_EMAIL_USER ||
        process.env.EMAIL_USER ||
        process.env.SMTP_USER;
    const pass =
        process.env.SYSTEM_EMAIL_PASS ||
        process.env.SMTP_PASS ||
        process.env.EMAIL_APP_PASSWORD;
    return { user, pass };
}

/**
 * Shared transporter for system emails — matches shopifyOAuth.js (STARTTLS + relaxed TLS for cloud hosts).
 */
function createSystemEmailTransporter() {
    const { user, pass } = getSystemEmailCredentials();
    if (!user || !pass) {
        console.error(
            '[EmailService] Missing system email credentials. Set SYSTEM_EMAIL_USER + SYSTEM_EMAIL_PASS (or EMAIL_USER + EMAIL_APP_PASSWORD / SMTP_USER + SMTP_PASS).'
        );
        return null;
    }
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(String(process.env.SMTP_PORT || '587'), 10) || 587,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: false },
        family: 4,
        connectionTimeout: 15000,
        auth: { user, pass }
    });
}

/**
 * Create a nodemailer transporter from client's stored email credentials.
 * Falls back to global env vars if client-specific ones are not set.
 */
function createTransporter(client) {
    const emailUser = client.emailUser || process.env.EMAIL_USER;
    const emailPass = client.emailAppPassword ? decrypt(client.emailAppPassword) : process.env.EMAIL_APP_PASSWORD;

    if (!emailUser || !emailPass) {
        console.warn(`[EmailService] No email credentials for client: ${client.clientId}`);
        return null;
    }

    return nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        family: 4,
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
 * Send a Review Request email after purchase.
 */
async function sendReviewRequestEmail(client, { customerEmail, customerName, productName, reviewUrl }) {
    const html = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; border: 1px solid #f1f5f9; border-radius: 24px; background: #ffffff;">
            <div style="text-align: center; margin-bottom: 32px;">
                <span style="font-size: 48px;">⭐</span>
                <h2 style="color: #0f172a; margin-top: 16px; font-weight: 800; letter-spacing: -0.02em;">How was your experience?</h2>
            </div>
            
            <p style="color: #475569; font-size: 16px; line-height: 1.6; text-align: center;">
                Hi ${customerName || 'there'}! 👋 <br/>
                We'd love to hear what you think about your recent purchase of <strong>${productName || 'our product'}</strong>.
            </p>
            
            <div style="text-align: center; margin: 40px 0;">
                <a href="${reviewUrl}" style="display: inline-block; padding: 18px 36px; background: #6366f1; color: white; border-radius: 16px; text-decoration: none; font-weight: 700; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.3);">
                    Leave a Review →
                </a>
            </div>
            
            <p style="color: #94a3b8; font-size: 14px; text-align: center; line-height: 1.5;">
                Your feedback helps us improve and helps other customers make better choices. Thank you for being part of our community!
            </p>
            
            <hr style="border: none; border-top: 1px solid #f1f5f9; margin-top: 40px;" />
            <p style="color: #cbd5e1; font-size: 12px; text-align: center; margin-top: 24px;">
                &copy; ${new Date().getFullYear()} ${client.name || 'Store'}. Sent via TopEdge AI.
            </p>
        </div>
    `;

    return sendEmail(client, {
        to: customerEmail,
        subject: `How was your experience with ${productName || 'us'}? ⭐`,
        html
    });
}
/**
 * Send a System OTP using the dedicated TopEdge AI credentials.
 */
async function sendSystemOTPEmail(toAddress, otpCode, purpose = 'SIGNUP') {
    const transporter = createSystemEmailTransporter();
    if (!transporter) return false;

    const fromUser = getSystemEmailCredentials().user;

    const isReset = purpose === 'RESET_PASSWORD';
    const subject = isReset 
        ? '🔐 Important: Password Reset Verification Code' 
        : '👋 Welcome to TopEdge AI - Verify Your Account';
    
    const themeColor = isReset ? '#ef4444' : '#6366f1';
    const headerTitle = isReset ? 'Security Protocol' : 'Identity Verification';
    const actionText = isReset 
        ? 'authorize your request to reset your enterprise account password' 
        : 'verify your email address and finish setting up your TopEdge AI workspace';

    const html = `
        <div style="font-family: 'Inter', -apple-system, Arial, sans-serif; max-width: 520px; margin: 40px auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05);">
            <div style="background: linear-gradient(135deg, ${themeColor} 0%, #000000 100%); padding: 40px 32px; text-align: center;">
                <h2 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.03em;">TopEdge AI</h2>
                <div style="margin-top: 12px; display: inline-block; padding: 6px 12px; background: rgba(255,255,255,0.1); border-radius: 100px; color: rgba(255,255,255,0.9); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; border: 1px solid rgba(255,255,255,0.1);">
                    ${headerTitle}
                </div>
            </div>
            
            <div style="padding: 40px 40px 32px 40px;">
                <p style="color: #0f172a; font-size: 16px; font-weight: 600; margin-top: 0;">Verification Code Generated</p>
                <p style="color: #475569; font-size: 15px; line-height: 1.6; margin-bottom: 32px;">
                    Hi, use the 6-digit code below to ${actionText}. This code is valid for <strong>5 minutes</strong>.
                </p>
                
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 20px; padding: 32px; text-align: center; margin-bottom: 32px;">
                    <span style="font-size: 38px; font-weight: 800; letter-spacing: 8px; color: ${themeColor}; font-family: 'Courier New', Courier, monospace;">${otpCode}</span>
                </div>
                
                <div style="padding: 20px; background-color: #fff7ed; border: 1px solid #ffedd5; border-radius: 16px; margin-bottom: 32px;">
                    <p style="color: #9a3412; font-size: 13px; font-weight: 700; margin: 0 0 4px 0; text-transform: uppercase; letter-spacing: 0.05em;">Security Notice</p>
                    <p style="color: #c2410c; font-size: 12px; font-weight: 500; margin: 0; line-height: 1.4;">
                        If you did not initiate this request, please ignore this email or contact support immediately if you suspect unauthorized activity.
                    </p>
                </div>
                
                <hr style="border: none; border-top: 1px solid #f1f5f9; margin-bottom: 24px;" />
                
                <div style="text-align: center;">
                    <p style="color: #94a3b8; font-size: 11px; margin-bottom: 4px;">Sent from <strong>support@topedgeai.com</strong></p>
                    <p style="color: #cbd5e1; font-size: 10px; margin: 0;">&copy; ${new Date().getFullYear()} TopEdge AI System Architecture. Verified Environment.</p>
                </div>
            </div>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"TopEdge AI Security" <${fromUser}>`,
            to: toAddress,
            subject,
            html
        });
        console.log(`[EmailService] System OTP sent to ${toAddress} | Purpose: ${purpose}`);
        return true;
    } catch (err) {
        console.error(
            `[EmailService] ❌ Failed to send System OTP to ${toAddress}:`,
            err.code || err.name,
            err.message,
            err.response || ''
        );
        return false;
    }
}

/**
 * Send a team invitation email to a new agent.
 */
async function sendTeamInviteEmail(toAddress, { adminName, businessName, password, loginUrl }) {
    const transporter = createSystemEmailTransporter();
    if (!transporter) return false;
    const fromUser = getSystemEmailCredentials().user;

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
            from: `"TopEdge AI" <${fromUser}>`,
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
    const transporter = createSystemEmailTransporter();
    if (!transporter) return false;
    const fromUser = getSystemEmailCredentials().user;

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
            from: `"TopEdge AI" <${fromUser}>`,
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
    sendReviewRequestEmail,
    sendSystemOTPEmail,
    sendTeamInviteEmail,
    sendAdminConfirmationEmail
};
