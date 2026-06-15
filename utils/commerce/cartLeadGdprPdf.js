'use strict';

const PDFDocument = require('pdfkit');

const MARGIN = 48;
const CONTENT_WIDTH = 499;

function pageBottom(doc) {
  return doc.page.height - MARGIN - 36;
}

function ensureSpace(doc, y, needed) {
  if (y + needed > pageBottom(doc)) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

/** Helvetica lacks ₹ — use Rs. with en-IN grouping (matches intelligence PDF). */
function formatInr(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '—';
  const hasDecimals = num % 1 !== 0;
  const formatted = num.toLocaleString('en-IN', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `Rs. ${formatted}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '—';
  }
}

function formatCartStatus(status) {
  const map = {
    active: 'Active checkout',
    abandoned: 'Abandoned',
    recovered: 'Recovered',
    purchased: 'Purchased',
    failed: 'Failed',
  };
  return map[String(status || '').toLowerCase()] || status || '—';
}

function normalizeCartItems(lead = {}) {
  const snap = lead.cartSnapshot || {};
  const raw = Array.isArray(snap.items) ? snap.items : Array.isArray(snap.line_items) ? snap.line_items : [];
  if (raw.length) {
    return raw.map((item, idx) => {
      const qty = Number(item.quantity || item.qty || 1) || 1;
      const unit = Number(item.price ?? item.line_price ?? item.presentment_price ?? 0) || 0;
      const lineTotal = Number(item.lineTotal ?? item.line_total ?? unit * qty) || unit * qty;
      return {
        title: item.title || item.name || item.product_title || `Item ${idx + 1}`,
        variant: item.variant_title || item.variant || '',
        quantity: qty,
        unitPrice: unit,
        lineTotal,
      };
    });
  }
  const titles = Array.isArray(snap.titles) ? snap.titles : [];
  const total = Number(snap.total_price ?? snap.totalPrice ?? lead.cartValue ?? 0) || 0;
  if (!titles.length) return [];
  const each = titles.length ? total / titles.length : total;
  return titles.map((title, idx) => ({
    title,
    variant: '',
    quantity: 1,
    unitPrice: each,
    lineTotal: each,
  }));
}

function cartItemCount(items) {
  return items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function cartTotalValue(items, lead = {}) {
  const lineSum = items.reduce((s, i) => s + (Number(i.lineTotal) || 0), 0);
  if (lineSum > 0) return lineSum;
  const snap = lead.cartSnapshot || {};
  return Number(snap.total_price ?? snap.totalPrice ?? lead.cartValue ?? 0) || 0;
}

function drawHeader(doc, exportedAt) {
  doc.rect(0, 0, doc.page.width, 96).fill('#faf5ff');
  doc.fillColor('#6d28d9').fontSize(17).font('Helvetica').text('TopEdge AI', MARGIN, 28);
  doc.fillColor('#64748b').fontSize(10).font('Helvetica').text('Abandoned cart lead export', MARGIN, 50);
  doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text(`Exported ${exportedAt}`, MARGIN, 68);
  return 112;
}

function drawSectionTitle(doc, y, title) {
  y = ensureSpace(doc, y, 28);
  doc.fillColor('#6d28d9').fontSize(11).font('Helvetica').text(title, MARGIN, y);
  doc.rect(MARGIN, y + 16, CONTENT_WIDTH, 1).fill('#e9d5ff');
  return y + 26;
}

function drawKpiStrip(doc, y, metrics) {
  y = ensureSpace(doc, y, 62);
  const colW = Math.floor(CONTENT_WIDTH / metrics.length);
  metrics.forEach((m, i) => {
    const x = MARGIN + i * colW;
    doc.roundedRect(x, y, colW - 8, 54, 8).fillAndStroke('#ffffff', '#e2e8f0');
    doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(m.label, x + 10, y + 10, { width: colW - 20 });
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica').text(m.value, x + 10, y + 26, { width: colW - 20 });
  });
  return y + 62;
}

function drawKeyValueGrid(doc, y, rows) {
  rows.forEach((row) => {
    y = ensureSpace(doc, y, 16);
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text(row.label, MARGIN, y, { width: 150 });
    doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(String(row.value ?? '—'), MARGIN + 158, y, {
      width: CONTENT_WIDTH - 158,
      lineGap: 1,
    });
    const valueHeight = doc.heightOfString(String(row.value ?? '—'), { width: CONTENT_WIDTH - 158, lineGap: 1 });
    y += Math.max(14, valueHeight + 4);
  });
  return y + 4;
}

function drawEmptyState(doc, y, text) {
  y = ensureSpace(doc, y, 36);
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 32, 8).fillAndStroke('#f8fafc', '#e2e8f0');
  doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text(text, MARGIN + 12, y + 11, { width: CONTENT_WIDTH - 24 });
  return y + 40;
}

function drawCartItemsTable(doc, y, items) {
  if (!items.length) {
    return drawEmptyState(doc, y, 'No line items stored on this lead.');
  }

  const cols = [
    { label: 'Product', x: MARGIN + 8, w: 240 },
    { label: 'Qty', x: MARGIN + 252, w: 36 },
    { label: 'Unit', x: MARGIN + 292, w: 88 },
    { label: 'Line total', x: MARGIN + 384, w: 100 },
  ];

  y = ensureSpace(doc, y, 24);
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 20, 6).fill('#f8fafc');
  cols.forEach((col) => {
    doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(col.label, col.x, y + 6, { width: col.w });
  });
  y += 24;

  for (const item of items.slice(0, 20)) {
    const titleLine = item.variant ? `${item.title} (${item.variant})` : item.title;
    const rowHeight = Math.max(
      22,
      doc.heightOfString(titleLine, { width: cols[0].w, lineGap: 1 }) + 10
    );
    y = ensureSpace(doc, y, rowHeight + 4);
    doc.rect(MARGIN, y, CONTENT_WIDTH, rowHeight).fill('#ffffff');
    doc.moveTo(MARGIN, y + rowHeight).lineTo(MARGIN + CONTENT_WIDTH, y + rowHeight).strokeColor('#f1f5f9').stroke();
    doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(titleLine, cols[0].x, y + 6, { width: cols[0].w, lineGap: 1 });
    doc.text(String(item.quantity), cols[1].x, y + 6, { width: cols[1].w });
    doc.text(formatInr(item.unitPrice), cols[2].x, y + 6, { width: cols[2].w });
    doc.text(formatInr(item.lineTotal), cols[3].x, y + 6, { width: cols[3].w });
    y += rowHeight + 2;
  }

  y = ensureSpace(doc, y, 22);
  doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Cart total', MARGIN + 292, y);
  doc.fillColor('#0f172a').fontSize(10).font('Helvetica').text(
    formatInr(items.reduce((s, i) => s + (Number(i.lineTotal) || 0), 0)),
    MARGIN + 384,
    y
  );
  return y + 18;
}

function drawActivityLog(doc, y, activityLog = []) {
  const entries = Array.isArray(activityLog) ? activityLog.slice(0, 25) : [];
  if (!entries.length) {
    return drawEmptyState(doc, y, 'No activity events recorded.');
  }
  for (const entry of entries) {
    const label = entry.label || entry.action || 'Event';
    const details = entry.details ? ` — ${entry.details}` : '';
    const ts = entry.timestamp || entry.at ? formatDateTime(entry.timestamp || entry.at) : '';
    const line = ts ? `${ts} · ${label}${details}` : `${label}${details}`;
    y = ensureSpace(doc, y, 16);
    doc.circle(MARGIN + 6, y + 5, 2).fill('#c4b5fd');
    doc.fillColor('#334155').fontSize(8.5).font('Helvetica').text(line, MARGIN + 16, y, {
      width: CONTENT_WIDTH - 20,
      lineGap: 1,
    });
    y += doc.heightOfString(line, { width: CONTENT_WIDTH - 20, lineGap: 1 }) + 6;
  }
  return y + 4;
}

function drawOrders(doc, y, orders = []) {
  if (!orders.length) {
    return drawEmptyState(doc, y, 'No linked Shopify orders for this phone or recovery match.');
  }
  for (const order of orders.slice(0, 10)) {
    const ref = order.orderNumber || order.orderId || order.shopifyOrderId || '—';
    const amount = formatInr(order.totalPrice ?? order.amount);
    const status = order.financialStatus || order.status || '—';
    const fulfillment = order.fulfillmentStatus ? ` · ${order.fulfillmentStatus}` : '';
    const payment = order.paymentMethod || (order.isCOD ? 'COD' : '');
    const created = formatDateTime(order.createdAt);
    y = ensureSpace(doc, y, 44);
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 38, 8).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(`Order #${String(ref).replace(/^#/, '')}`, MARGIN + 10, y + 8);
    doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(
      `${amount} · ${status}${fulfillment}${payment ? ` · ${payment}` : ''}`,
      MARGIN + 10,
      y + 22,
      { width: CONTENT_WIDTH - 20 }
    );
    doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text(created, MARGIN + CONTENT_WIDTH - 120, y + 8, {
      width: 110,
      align: 'right',
    });
    y += 44;
  }
  return y + 4;
}

function drawMessages(doc, y, messages = []) {
  if (!messages.length) {
    return drawEmptyState(doc, y, 'No WhatsApp messages on file for this customer.');
  }
  const sorted = [...messages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const msg of sorted.slice(0, 30)) {
    const outbound = msg.direction === 'outgoing' || msg.direction === 'outbound';
    const body = String(msg.content || msg.text || '(media / template)').slice(0, 400);
    const ts = formatDateTime(msg.createdAt);
    const sender = outbound ? 'Outbound' : 'Customer';
    const textHeight = doc.heightOfString(body, { width: CONTENT_WIDTH - 28, lineGap: 2 });
    const bubbleH = textHeight + 28;
    y = ensureSpace(doc, y, bubbleH + 8);
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, bubbleH, 8).fillAndStroke(
      outbound ? '#f5f3ff' : '#f8fafc',
      outbound ? '#ddd6fe' : '#e2e8f0'
    );
    doc.fillColor('#64748b').fontSize(7.5).font('Helvetica').text(`${sender} · ${ts}`, MARGIN + 10, y + 8);
    doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica').text(body, MARGIN + 10, y + 20, {
      width: CONTENT_WIDTH - 20,
      lineGap: 2,
    });
    y += bubbleH + 8;
  }
  return y + 4;
}

function drawRecoverySequence(doc, y, sequences = [], lead = {}) {
  const seq = sequences[0];
  const steps = Array.isArray(seq?.steps) ? seq.steps : [];
  if (!steps.length && !lead.recoveryStep) {
    return drawEmptyState(doc, y, 'No recovery sequence enrolled for this lead.');
  }

  if (lead.recoveryStep) {
    y = ensureSpace(doc, y, 14);
    doc.fillColor('#334155').fontSize(9).font('Helvetica').text(
      `Recovery messages sent: step ${lead.recoveryStep} of 3`,
      MARGIN,
      y
    );
    y += 16;
  }

  if (lead.recoveredViaWhatsApp) {
    y = ensureSpace(doc, y, 14);
    doc.fillColor('#059669').fontSize(9).font('Helvetica').text('Attributed to WhatsApp recovery', MARGIN, y);
    y += 16;
  }

  for (const step of steps.slice(0, 6)) {
    const status = step.status || 'pending';
    const label = step.label || step.templateName || `Step ${step.step || ''}`;
    const sendAt = step.sendAt ? formatDateTime(step.sendAt) : '—';
    const sentAt = step.sentAt ? formatDateTime(step.sentAt) : null;
    y = ensureSpace(doc, y, 16);
    doc.fillColor('#64748b').fontSize(8.5).font('Helvetica').text(`${label} · ${status}`, MARGIN, y, { width: 280 });
    doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica').text(sentAt ? `Sent ${sentAt}` : `Scheduled ${sendAt}`, MARGIN + 290, y, {
      width: CONTENT_WIDTH - 290,
    });
    y += 14;
  }
  return y + 4;
}

function drawFooter(doc) {
  doc.fillColor('#94a3b8').fontSize(7).font('Helvetica').text(
    'Confidential — GDPR data export generated by TopEdge AI',
    MARGIN,
    doc.page.height - 32,
    { align: 'center', width: CONTENT_WIDTH }
  );
}

/**
 * Stream a formatted GDPR cart-lead export PDF from leadGdpr bundle.
 */
function streamCartLeadGdprPdf(bundle, res, { filename }) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: 'TopEdge AI — Cart lead export',
      Author: 'TopEdge AI',
    },
  });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  const lead = bundle?.records?.AdLead?.[0] || {};
  const orders = bundle?.records?.Order || [];
  const messages = bundle?.records?.Message || [];
  const sequences = bundle?.records?.FollowUpSequence || [];
  const exportedAt = formatDateTime(bundle?.exportedAt || new Date());

  const items = normalizeCartItems(lead);
  const itemCount = cartItemCount(items) || '—';
  const cartValue = formatInr(cartTotalValue(items, lead));
  const recoveredAt = lead.recoveredAt || lead.abandonedCartRecoveredAt || null;
  const abandonedAt = lead.cartAbandonedAt || lead.lastCartEventAt || null;

  let y = drawHeader(doc, exportedAt);

  y = drawKpiStrip(doc, y + 4, [
    { label: 'Cart value', value: cartValue },
    { label: 'Items', value: String(itemCount) },
    {
      label: lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased' ? 'Recovered' : 'Status',
      value:
        lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased'
          ? formatDateTime(recoveredAt).split(',')[0] || formatCartStatus(lead.cartStatus)
          : formatCartStatus(lead.cartStatus),
    },
  ]);

  y += 6;
  y = drawSectionTitle(doc, y, 'Customer & cart');
  y = drawKeyValueGrid(doc, y, [
    { label: 'Customer', value: lead.name || 'Guest shopper' },
    { label: 'Phone', value: lead.phoneNumber || '—' },
    { label: 'Email', value: lead.email || '—' },
    { label: 'Cart status', value: formatCartStatus(lead.cartStatus) },
    { label: 'Abandoned', value: formatDateTime(abandonedAt) },
    { label: 'Recovered', value: formatDateTime(recoveredAt) },
    { label: 'Contact captured', value: formatDateTime(lead.contactCapturedAt) },
    { label: 'Checkout started', value: formatDateTime(lead.checkoutInitiatedAt) },
    { label: 'Lead source', value: lead.source || '—' },
    { label: 'UTM campaign', value: lead.utmCampaign || '—' },
    { label: 'Referrer', value: lead.referrerDomain || '—' },
    { label: 'Tags', value: Array.isArray(lead.tags) && lead.tags.length ? lead.tags.join(', ') : '—' },
    { label: 'Recovery URL', value: lead.recoveryUrl || lead.cartSnapshot?.checkoutUrl || lead.checkoutUrl || '—' },
    { label: 'Lead ID', value: String(lead._id || bundle.leadId || '—') },
  ]);

  y += 4;
  y = drawSectionTitle(doc, y, `Cart items (${items.length})`);
  y = drawCartItemsTable(doc, y, items);

  y += 4;
  y = drawSectionTitle(doc, y, 'Recovery sequence');
  y = drawRecoverySequence(doc, y, sequences, lead);

  y += 4;
  y = drawSectionTitle(doc, y, 'Activity timeline');
  y = drawActivityLog(doc, y, lead.activityLog);

  y += 4;
  y = drawSectionTitle(doc, y, `Orders (${orders.length})`);
  y = drawOrders(doc, y, orders);

  y += 4;
  y = drawSectionTitle(doc, y, `Messages (${messages.length})`);
  y = drawMessages(doc, y, messages);

  const extras = [];
  const pixelCount = (bundle?.records?.PixelEvent || []).length;
  const clickCount = (bundle?.records?.LinkClickEvent || []).length;
  if (pixelCount) extras.push(`${pixelCount} pixel events`);
  if (clickCount) extras.push(`${clickCount} link clicks`);
  if (extras.length) {
    y = ensureSpace(doc, y, 20);
    y = drawSectionTitle(doc, y, 'Engagement signals');
    y = drawKeyValueGrid(doc, y, [{ label: 'Captured events', value: extras.join(' · ') }]);
  }

  drawFooter(doc);
  doc.end();
}

module.exports = {
  streamCartLeadGdprPdf,
  formatInr,
  normalizeCartItems,
  formatCartStatus,
};
