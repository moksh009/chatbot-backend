const nodemailer = require('nodemailer');
const dns = require('dns');
const net = require('net');
const { decrypt } = require('./encryption');

/** Prefer A records over AAAA on hosts where IPv6 egress is broken (common on PaaS). */
if (typeof dns.setDefaultResultOrder === 'function') {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch (_) { /* noop */ }
}

function ipv4Lookup(hostname, options, callback) {
  return dns.lookup(hostname, { family: 4, all: false }, callback);
}

/**
 * Resolve logical SMTP hostname to an IPv4 address before TCP connect.
 * Render / some PaaS still hit AAAA or ignore nodemailer `lookup` → ENETUNREACH to Gmail IPv6.
 * Uses resolved IP as `host` and keeps logical name as TLS SNI (`servername`).
 */
async function resolveSmtpIpv4Target(logicalHostname) {
  const logical = String(logicalHostname || 'smtp.gmail.com').trim() || 'smtp.gmail.com';
  if (net.isIP(logical) === 4) {
    return { connectHost: logical, tlsServername: logical };
  }
  try {
    const { address } = await dns.promises.lookup(logical, { family: 4 });
    if (address && net.isIP(address) === 4) {
      return { connectHost: address, tlsServername: logical };
    }
  } catch (e) {
    // #region agent log
    try {
      const { agentDebug } = require('./agentDebugLog');
      agentDebug({
        hypothesisId: 'H2',
        location: 'emailService.js:resolveSmtpIpv4Target',
        message: 'ipv4_lookup_failed',
        data: { code: e.code, logicalHostLen: logical.length }
      });
    } catch (_) { /* noop */ }
    // #endregion
  }
  return { connectHost: logical, tlsServername: logical };
}

const SMTP_RETRYABLE = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKETTIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ESOCKET'
]);

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

function _smtpConnTimeouts() {
    const connectionTimeout = parseInt(String(process.env.SMTP_CONNECTION_TIMEOUT || '38000'), 10) || 38000;
    const greetingTimeout = parseInt(String(process.env.SMTP_GREETING_TIMEOUT || '22000'), 10) || 22000;
    const socketTimeout = parseInt(String(process.env.SMTP_SOCKET_TIMEOUT || '60000'), 10) || 60000;
    return { connectionTimeout, greetingTimeout, socketTimeout };
}

/**
 * Single SMTP transporter for system mail (one port / mode).
 */
function createSystemEmailTransporterFor({ port, secure, requireTLS }, smtpTarget = null) {
    const { user, pass } = getSystemEmailCredentials();
    if (!user || !pass) {
        console.error(
            '[EmailService] Missing system email credentials. Set SYSTEM_EMAIL_USER + SYSTEM_EMAIL_PASS (or EMAIL_USER + EMAIL_APP_PASSWORD / SMTP_USER + SMTP_PASS).'
        );
        return null;
    }
    const logicalHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const connectHost = smtpTarget?.connectHost || logicalHost;
    const tlsServername = smtpTarget?.tlsServername || logicalHost;
    const { connectionTimeout, greetingTimeout, socketTimeout } = _smtpConnTimeouts();
    return nodemailer.createTransport({
        host: connectHost,
        port,
        secure,
        requireTLS: !!requireTLS,
        tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: tlsServername },
        family: 4,
        lookup: ipv4Lookup,
        pool: false,
        connectionTimeout,
        greetingTimeout,
        socketTimeout,
        auth: { user, pass }
    });
}

function getSystemSmtpAttemptOrder() {
    const envPort = parseInt(String(process.env.SMTP_PORT || ''), 10);
    const a587 = { port: 587, secure: false, requireTLS: true, label: '587+STARTTLS' };
    const a465 = { port: 465, secure: true, requireTLS: false, label: '465+SSL' };
    if (envPort === 465) return [a465, a587];
    if (envPort === 587) return [a587, a465];
    // Cloud hosts often block 587 or break IPv6 to Gmail; try implicit SSL first unless opted out.
    if (String(process.env.SMTP_TRY_STARTTLS_FIRST || '').toLowerCase() === 'true') {
        return [a587, a465];
    }
    return [a465, a587];
}

/**
 * Try SMTP with port fallback (587 then 465, or env SMTP_PORT first).
 * Fixes cloud ETIMEDOUT where one path is blocked but the other works.
 */
async function sendViaSystemSmtpWithFallback(mailOptions) {
    const attempts = getSystemSmtpAttemptOrder();
    const logicalHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpTarget = await resolveSmtpIpv4Target(logicalHost);
    const usingResolvedIp = net.isIP(smtpTarget.connectHost) === 4 && smtpTarget.connectHost !== logicalHost;
    // #region agent log
    try {
        const { agentDebug } = require('./agentDebugLog');
        agentDebug({
            hypothesisId: 'H1',
            location: 'emailService.js:sendViaSystemSmtpWithFallback',
            message: 'smtp_precheck',
            data: {
                logicalHostLen: logicalHost.length,
                connectIsIpv4: net.isIP(smtpTarget.connectHost) === 4,
                usingResolvedIp,
                attemptLabels: attempts.map((a) => a.label),
                envSmtpPort: process.env.SMTP_PORT || null,
                dnsOrder: typeof dns.setDefaultResultOrder === 'function' ? 'ipv4first_set' : 'no_setDefaultResultOrder'
            }
        });
    } catch (_) { /* noop */ }
    // #endregion
    console.log('[EmailService] SMTP connect precheck', {
        usingResolvedIp,
        connectKind: net.isIP(smtpTarget.connectHost) === 4 ? 'ipv4' : 'hostname'
    });
    let lastErr;
    for (const cfg of attempts) {
        const t = createSystemEmailTransporterFor(cfg, smtpTarget);
        if (!t) return false;
        try {
            await t.sendMail(mailOptions);
            console.log(`[EmailService] ✅ System SMTP sent via ${cfg.label} (${cfg.port})`);
            // #region agent log
            try {
                const { agentDebug } = require('./agentDebugLog');
                agentDebug({
                    hypothesisId: 'H5',
                    location: 'emailService.js:sendViaSystemSmtpWithFallback',
                    message: 'smtp_send_ok',
                    data: { via: cfg.label, port: cfg.port, usingResolvedIp }
                });
            } catch (_) { /* noop */ }
            // #endregion
            try {
                t.close();
            } catch (_) { /* noop */ }
            return true;
        } catch (err) {
            lastErr = err;
            console.warn(
                `[EmailService] SMTP ${cfg.label} failed:`,
                err.code || err.name,
                err.message
            );
            // #region agent log
            try {
                const { agentDebug } = require('./agentDebugLog');
                const msg0 = String(err.message || '');
                agentDebug({
                    hypothesisId: 'H3',
                    location: 'emailService.js:sendViaSystemSmtpWithFallback',
                    message: 'smtp_attempt_failed',
                    data: {
                        via: cfg.label,
                        port: cfg.port,
                        errCode: err.code || err.name || null,
                        hasV6InMsg: /::|([0-9a-f]{0,4}:){2,}/i.test(msg0),
                        usingResolvedIp
                    }
                });
            } catch (_) { /* noop */ }
            // #endregion
            try {
                t.close();
            } catch (_) { /* noop */ }
            if (err.code === 'EAUTH') break;
            const msg0 = String(err.message || '');
            const retryMsg0 = /ENETUNREACH|EHOSTUNREACH|network|unreachable|socket/i.test(msg0);
            if (!SMTP_RETRYABLE.has(err.code) && !/timeout|timed out/i.test(msg0) && !retryMsg0) break;
        }
    }
    if (lastErr) {
        console.error('[EmailService] All system SMTP attempts failed:', lastErr.code, lastErr.message);
    }
    return false;
}

async function deliverSystemEmail(mailOptions) {
    const { user, pass } = getSystemEmailCredentials();
    if (!user || !pass) {
        // #region agent log
        try {
            const { agentDebug } = require('./agentDebugLog');
            agentDebug({
                hypothesisId: 'H6',
                location: 'emailService.js:deliverSystemEmail',
                message: 'missing_system_smtp_creds',
                data: { hasUser: !!user, hasPass: !!pass }
            });
        } catch (_) { /* noop */ }
        // #endregion
        return false;
    }
    // From must match authenticated SMTP user for Gmail and most providers.
    const safeFrom =
        mailOptions.from && String(mailOptions.from).includes(user)
            ? mailOptions.from
            : `"TopEdge AI" <${user}>`;
    const ok = await sendViaSystemSmtpWithFallback({ ...mailOptions, from: safeFrom });
    // #region agent log
    try {
        const { agentDebug } = require('./agentDebugLog');
        agentDebug({
            hypothesisId: 'H6',
            location: 'emailService.js:deliverSystemEmail',
            message: 'smtp_deliver_finished',
            data: { ok: !!ok, toDomain: String(mailOptions.to || '').split('@')[1] || null }
        });
    } catch (_) { /* noop */ }
    // #endregion
    return ok;
}

/**
 * Shared transporter for system emails — single port from env (shopifyOAuth / legacy callers).
 */
function createSystemEmailTransporter() {
    const envPort = parseInt(String(process.env.SMTP_PORT || '465'), 10) || 465;
    const secure = envPort === 465;
    return createSystemEmailTransporterFor(
        {
            port: envPort,
            secure,
            requireTLS: !secure
        },
        null
    );
}

/**
 * Create a nodemailer transporter from client's stored email credentials.
 * Falls back to global env vars if client-specific ones are not set.
 */
function createTransporterForClient(client, { port, secure, requireTLS }, smtpTarget = null) {
    const emailUser = client.emailUser || process.env.EMAIL_USER;
    const emailPass = client.emailAppPassword ? decrypt(client.emailAppPassword) : process.env.EMAIL_APP_PASSWORD;

    if (!emailUser || !emailPass) {
        console.warn(`[EmailService] No email credentials for client: ${client.clientId}`);
        return null;
    }

    const logicalHost = client.smtpHost || process.env.CLIENT_SMTP_HOST || 'smtp.gmail.com';
    const connectHost = smtpTarget?.connectHost || logicalHost;
    const tlsServername = smtpTarget?.tlsServername || logicalHost;
    const { connectionTimeout, greetingTimeout, socketTimeout } = _smtpConnTimeouts();

    return nodemailer.createTransport({
        host: connectHost,
        port,
        secure,
        requireTLS: !!requireTLS,
        tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: tlsServername },
        family: 4,
        lookup: ipv4Lookup,
        pool: false,
        connectionTimeout,
        greetingTimeout,
        socketTimeout,
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });
}

/** Prefer 587+STARTTLS from cloud hosts; 465 SSL as alternate in sendEmail retry. */
function createTransporter(client) {
    const port = parseInt(String(client.smtpPort || process.env.CLIENT_SMTP_PORT || '465'), 10) || 465;
    const secure = port === 465;
    return createTransporterForClient(client, { port, secure, requireTLS: !secure });
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

    const fromAddr = client.emailUser || process.env.EMAIL_USER;
    const from = `"${client.name || 'Store'}" <${fromAddr}>`;
    const mail = { from, to, subject, html };

    const logicalSmtpHost = client.smtpHost || process.env.CLIENT_SMTP_HOST || 'smtp.gmail.com';
    const smtpTarget = await resolveSmtpIpv4Target(logicalSmtpHost);

    const preferStartTls = String(process.env.SMTP_TRY_STARTTLS_FIRST || '').toLowerCase() === 'true';
    const defaultPort = parseInt(String(client.smtpPort || process.env.CLIENT_SMTP_PORT || '465'), 10) || 465;
    const tryOrder =
        defaultPort === 465 && !preferStartTls
            ? [
                  { port: 465, secure: true, requireTLS: false, label: '465+SSL' },
                  { port: 587, secure: false, requireTLS: true, label: '587+STARTTLS' }
              ]
            : defaultPort === 587 || preferStartTls
              ? [
                    { port: 587, secure: false, requireTLS: true, label: '587+STARTTLS' },
                    { port: 465, secure: true, requireTLS: false, label: '465+SSL' }
                ]
              : [
                    { port: 465, secure: true, requireTLS: false, label: '465+SSL' },
                    { port: 587, secure: false, requireTLS: true, label: '587+STARTTLS' }
                ];

    let lastErr;
    for (const cfg of tryOrder) {
        const transporter = createTransporterForClient(client, cfg, smtpTarget);
        if (!transporter) return false;
        try {
            await transporter.sendMail(mail);
            console.log(`[EmailService] ✅ Email sent to ${to} | Subject: ${subject} (${cfg.label})`);
            try {
                transporter.close();
            } catch (_) { /* noop */ }
            return true;
        } catch (err) {
            lastErr = err;
            console.warn(`[EmailService] Client SMTP ${cfg.label} failed:`, err.code, err.message);
            try {
                transporter.close();
            } catch (_) { /* noop */ }
            if (err.code === 'EAUTH') break;
            const msg = String(err.message || '');
            const retryMsg = /ENETUNREACH|EHOSTUNREACH|network|unreachable|socket/i.test(msg);
            if (!SMTP_RETRYABLE.has(err.code) && !/timeout|timed out/i.test(msg) && !retryMsg) break;
        }
    }
    console.error(`[EmailService] ❌ Failed to send email to ${to}:`, lastErr?.message);
    return false;
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
    const { user: fromUser, pass: fromPass } = getSystemEmailCredentials();
    if (!fromUser || !fromPass) {
        console.error(
            '[EmailService] Cannot send OTP: set SYSTEM_EMAIL_USER + SYSTEM_EMAIL_PASS (Gmail app password). Optional: SMTP_HOST, SMTP_PORT=465.'
        );
        return false;
    }

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

    const fromHeader = `"TopEdge AI Security" <${fromUser}>`;
    const ok = await deliverSystemEmail({
        from: fromHeader,
        to: toAddress,
        subject,
        html
    });
    if (ok) {
        console.log(`[EmailService] System OTP sent to ${toAddress} | Purpose: ${purpose}`);
    } else {
        console.error(
            `[EmailService] ❌ Failed to send System OTP to ${toAddress} — check SMTP (465/587), app password, and IPv4 egress (see logs above).`
        );
    }
    return ok;
}

/**
 * Send a team invitation email to a new agent.
 */
async function sendTeamInviteEmail(toAddress, { adminName, businessName, password, loginUrl }) {
    const { user: fromUser, pass: fromPass } = getSystemEmailCredentials();
    if (!fromUser || !fromPass) return false;

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

    const fromHeader = `"TopEdge AI" <${fromUser}>`;
    return deliverSystemEmail({
        from: fromHeader,
        to: toAddress,
        subject: `👋 You've been invited to join ${businessName} on TopEdge AI`,
        html
    });
}

/**
 * Send an admin confirmation email when a new member is invited.
 */
/**
 * Escape text for safe inclusion in HTML email bodies.
 */
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Enterprise HTML for human-escalation / admin_alert emails (used by notificationService).
 */
function buildAdminEscalationEmailHtml({
    brandName = 'Your store',
    topic = 'Support request',
    triggerSource = 'WhatsApp automation',
    customerPhone = '',
    customerQuery = '',
    takeoverLink = '#',
}) {
    const q = String(customerQuery || '').trim();
    const queryBlock = q
        ? `<div style="margin-top:20px;padding:16px;background:#0f172a08;border-radius:12px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Customer message</p>
            <p style="margin:0;font-size:14px;line-height:1.55;color:#0f172a;white-space:pre-wrap;">${escapeHtml(q)}</p>
           </div>`
        : '';

    return `
        <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:40px 32px;background:#f8fafc;">
          <div style="background:#fff;border-radius:20px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 25px 50px -12px rgba(15,23,42,0.12);">
            <div style="padding:28px 28px 12px;border-bottom:1px solid #f1f5f9;">
              <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:#fef2f2;color:#b91c1c;font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;">Escalation · TopEdge AI</span>
              <h1 style="margin:16px 0 0;font-size:22px;font-weight:800;color:#0f172a;line-height:1.25;">${escapeHtml(topic)}</h1>
              <p style="margin:10px 0 0;font-size:14px;color:#64748b;line-height:1.5;">A shopper on <strong style="color:#334155;">${escapeHtml(brandName)}</strong> needs a human. Details below — act fast; speed wins conversions.</p>
            </div>
            <div style="padding:24px 28px 32px;">
              <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <tr><td style="padding:10px 0;color:#94a3b8;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:0.06em;width:38%;">Source</td><td style="padding:10px 0;text-align:right;color:#0f172a;font-weight:600;">${escapeHtml(triggerSource)}</td></tr>
                <tr><td style="padding:10px 0;color:#94a3b8;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:0.06em;">Customer WhatsApp</td><td style="padding:10px 0;text-align:right;color:#4f46e5;font-weight:800;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(customerPhone)}</td></tr>
              </table>
              ${queryBlock}
              <a href="${escapeHtml(takeoverLink)}" style="display:block;margin-top:28px;text-align:center;padding:16px 20px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#fff!important;text-decoration:none;border-radius:14px;font-weight:800;font-size:14px;letter-spacing:0.02em;">Open conversation in dashboard →</a>
              <p style="margin:24px 0 0;font-size:11px;color:#94a3b8;line-height:1.6;text-align:center;">If the button is blocked, copy this link: <span style="word-break:break-all;color:#64748b;">${escapeHtml(takeoverLink)}</span></p>
            </div>
          </div>
          <p style="text-align:center;margin-top:24px;font-size:11px;color:#94a3b8;">TopEdge AI · Enterprise WhatsApp CX</p>
        </div>`;
}

async function sendAdminConfirmationEmail(adminEmail, { agentName, agentEmail, businessName }) {
    const { user: fromUser, pass: fromPass } = getSystemEmailCredentials();
    if (!fromUser || !fromPass) return false;

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

    const fromHeader = `"TopEdge AI" <${fromUser}>`;
    return deliverSystemEmail({
        from: fromHeader,
        to: adminEmail,
        subject: `✅ Invitation Sent: ${agentName} has been invited`,
        html
    });
}

module.exports = {
    sendEmail,
    escapeHtml,
    buildAdminEscalationEmailHtml,
    sendAbandonedCartEmail,
    sendOrderConfirmationEmail,
    sendCODToPrepaidEmail,
    sendReviewRequestEmail,
    sendSystemOTPEmail,
    sendTeamInviteEmail,
    sendAdminConfirmationEmail,
    createSystemEmailTransporter,
    deliverSystemEmail
};
