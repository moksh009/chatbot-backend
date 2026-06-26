'use strict';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip WhatsApp markdown (*bold*, _italic_, ~strike~) for email display. */
function stripWhatsAppFormatting(text) {
  return String(text || '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~([^~]+)~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatPhoneForDisplay(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return String(phone || '—').trim() || '—';
}

function formatIstTimestamp(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch (_) {
    return new Date(date).toLocaleString('en-IN');
  }
}

/** Subject: alert first, then phone, then store name (mobile inbox friendly). */
function buildAdminEscalationSubject({ brandName = 'Your store', customerPhone = '' } = {}) {
  const phone = formatPhoneForDisplay(customerPhone);
  const brand = String(brandName || 'Your store').trim().slice(0, 48);
  return `🚨 Human help needed · ${phone} · ${brand}`;
}

function pickLastCustomerMessage(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const dir = String(m?.direction || '').toLowerCase();
    const isCustomer = dir === 'incoming' || dir === 'inbound' || m?.from === 'user';
    if (!isCustomer) continue;
    const text = stripWhatsAppFormatting(m?.content || m?.body || '');
    if (text) return text.slice(0, 280);
  }
  return '';
}

function formatTranscriptLine(msg) {
  const dir = String(msg?.direction || '').toLowerCase();
  const who = dir === 'incoming' || dir === 'inbound' ? 'Customer' : msg?.from === 'BOT' ? 'Bot' : 'Agent';
  const text = stripWhatsAppFormatting(msg?.content || msg?.body || '').slice(0, 120);
  if (!text) return '';
  if (who === 'Bot' && text.length > 100) return '';
  return `<p style="margin:0 0 8px;font-size:12px;line-height:1.45;color:#475569;"><span style="font-weight:600;color:#0f172a;">${escapeHtml(who)}</span> ${escapeHtml(text)}</p>`;
}

function formatOrderSummary(order) {
  if (!order) return '';
  const num = String(order.orderNumber || order.orderId || '—').replace(/^#/, '');
  const amt = order.totalPrice != null ? `₹${Math.round(Number(order.totalPrice) || 0).toLocaleString('en-IN')}` : '';
  const fin = String(order.financialStatus || order.status || '').replace(/_/g, ' ') || '—';
  return `<p style="margin:0;font-size:13px;color:#334155;line-height:1.4;"><strong style="color:#0f172a;">#${escapeHtml(num)}</strong>${amt ? ` · ${escapeHtml(amt)}` : ''} · ${escapeHtml(fin)}</p>`;
}

function buildAdminEscalationEmailText({
  brandName = 'Your store',
  topic = 'Support request',
  triggerSource = 'WhatsApp automation',
  customerPhone = '',
  customerName = '',
  customerQuery = '',
  takeoverLink = '#',
  recentMessages = [],
  isTest = false,
} = {}) {
  const phone = formatPhoneForDisplay(customerPhone);
  const lastCustomer = pickLastCustomerMessage(recentMessages) || stripWhatsAppFormatting(customerQuery);
  const lines = [
    isTest ? '🚨 TEST — Human help needed (no action required)' : '🚨 Human help needed',
    `${brandName} · ${formatIstTimestamp()}`,
    '',
    `Customer: ${customerName || 'Customer'}`,
    `WhatsApp: ${phone}`,
    `Source: ${triggerSource}`,
    topic && topic !== 'Priority support' && !/^test admin alert/i.test(topic) ? `Note: ${topic}` : '',
    '',
    lastCustomer ? `Message: ${lastCustomer}` : '',
    '',
    `Open: ${takeoverLink}`,
    '',
    'TopEdge AI',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildAdminEscalationEmailHtml({
  brandName = 'Your store',
  topic = 'Support request',
  triggerSource = 'WhatsApp automation',
  customerPhone = '',
  customerName = '',
  customerQuery = '',
  takeoverLink = '#',
  recentMessages = [],
  recentOrders = [],
  isTest = false,
} = {}) {
  const phoneDisplay = formatPhoneForDisplay(customerPhone);
  const telHref = customerPhone ? `tel:${String(customerPhone).replace(/\s/g, '')}` : '#';
  const lastCustomer = pickLastCustomerMessage(recentMessages) || stripWhatsAppFormatting(customerQuery);
  const topicChip =
    topic && !/^test admin alert/i.test(topic) && topic !== 'Priority support'
      ? `<p style="margin:8px 0 0;font-size:12px;color:#64748b;line-height:1.4;">${escapeHtml(topic)}</p>`
      : '';

  const testBanner = isTest
    ? `<div style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;font-weight:600;text-align:center;">Test alert — no action needed</div>`
    : '';

  const messageBlock = lastCustomer
    ? `<div style="margin-top:12px;padding:12px;background:#ffffff;border-radius:10px;border:1px solid #e8ecf1;">
        <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Latest message</p>
        <p style="margin:0;font-size:14px;line-height:1.5;color:#0f172a;">${escapeHtml(lastCustomer)}</p>
       </div>`
    : '';

  const transcriptLines = (Array.isArray(recentMessages) ? recentMessages : [])
    .map(formatTranscriptLine)
    .filter(Boolean)
    .slice(-3);
  const transcriptBlock =
    !isTest && transcriptLines.length > 1
      ? `<div style="margin-top:10px;padding:12px;background:#ffffff;border-radius:10px;border:1px solid #e8ecf1;">
        <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Recent chat</p>
        ${transcriptLines.join('')}
       </div>`
      : '';

  const order = Array.isArray(recentOrders) && recentOrders.length ? recentOrders[0] : null;
  const ordersBlock = order
    ? `<div style="margin-top:10px;padding:12px;background:#faf5ff;border-radius:10px;border:1px solid #ede9fe;">
        <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#7c3aed;">Latest order</p>
        ${formatOrderSummary(order)}
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <style>
    @media only screen and (max-width: 620px) {
      .te-wrap { padding: 4px !important; }
      .te-card { border-radius: 12px !important; }
      .te-pad { padding: 12px !important; }
      .te-head { padding: 12px 12px 10px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#eef2f7;-webkit-text-size-adjust:100%;">
  <div class="te-wrap" style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:8px;">
    <div class="te-card" style="background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,0.06);">
      <div style="height:4px;background:linear-gradient(90deg,#7c3aed 0%,#a78bfa 100%);line-height:4px;font-size:0;">&nbsp;</div>
      <div class="te-head" style="padding:14px 14px 12px;border-bottom:1px solid #f1f5f9;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td style="vertical-align:top;width:28px;padding:0 8px 0 0;">
              <div style="width:28px;height:28px;border-radius:8px;background:#fef2f2;text-align:center;line-height:28px;font-size:14px;">🚨</div>
            </td>
            <td style="vertical-align:top;padding:0;">
              <p style="margin:0;font-size:17px;font-weight:800;color:#0f172a;line-height:1.25;">Human help needed</p>
              <p style="margin:4px 0 0;font-size:13px;color:#64748b;line-height:1.35;">${escapeHtml(brandName)} · ${escapeHtml(formatIstTimestamp())}</p>
              ${topicChip}
            </td>
          </tr>
        </table>
      </div>
      <div class="te-pad" style="padding:14px;">
        ${testBanner}
        <div style="padding:12px;background:#f8fafc;border-radius:10px;border:1px solid #e8ecf1;">
          <p style="margin:0 0 2px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Customer</p>
          <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#0f172a;line-height:1.3;">${escapeHtml(customerName || 'Customer')}</p>
          <p style="margin:0 0 2px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">WhatsApp</p>
          <p style="margin:0 0 10px;font-size:17px;font-weight:800;line-height:1.2;"><a href="${escapeHtml(telHref)}" style="color:#7c3aed;text-decoration:none;">${escapeHtml(phoneDisplay)}</a></p>
          <p style="margin:0 0 2px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Source</p>
          <p style="margin:0;font-size:12px;color:#475569;line-height:1.4;">${escapeHtml(triggerSource)}</p>
        </div>
        ${messageBlock}
        ${transcriptBlock}
        ${ordersBlock}
        <a href="${escapeHtml(takeoverLink)}" style="display:block;margin-top:14px;text-align:center;padding:13px 16px;background:#7c3aed;color:#ffffff!important;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;line-height:1.25;min-height:44px;box-sizing:border-box;">Open in dashboard</a>
        <p style="margin:10px 0 0;font-size:10px;color:#94a3b8;line-height:1.45;text-align:center;word-break:break-all;">${escapeHtml(takeoverLink)}</p>
      </div>
    </div>
    <p style="text-align:center;margin:10px 0 4px;font-size:10px;color:#94a3b8;">TopEdge AI</p>
  </div>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  stripWhatsAppFormatting,
  formatPhoneForDisplay,
  buildAdminEscalationSubject,
  buildAdminEscalationEmailHtml,
  buildAdminEscalationEmailText,
  pickLastCustomerMessage,
};
