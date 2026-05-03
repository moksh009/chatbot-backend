/**
 * Merge {{ token }} placeholders in email subject/HTML against a lead + client.
 */

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function extractTokens(text) {
  const s = String(text || '');
  const out = new Set();
  let m;
  const re = new RegExp(TOKEN_RE.source, 'g');
  while ((m = re.exec(s)) !== null) {
    const raw = (m[1] || '').trim();
    if (raw) out.add(raw);
  }
  return [...out];
}

const KNOWN = new Set([
  'first_name',
  'name',
  'email',
  'phone',
  'phone_number',
  'store_name',
  'cart_items_html',
  'cart_url',
  'cart_total',
  'loyalty_points',
  'loyalty_tier'
]);

function normalizeKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstToken(name) {
  if (!name || !String(name).trim()) return '';
  return String(name).trim().split(/\s+/)[0] || '';
}

function buildCartItemsHtml(lead) {
  const items = lead?.cartSnapshot?.items;
  if (!Array.isArray(items) || !items.length) {
    return `<p style="margin:0;padding:16px;color:#64748b;font-size:13px;border:1px dashed #e2e8f0;border-radius:12px;background:#f8fafc;">No cart snapshot on file for this contact — cart blocks will appear empty unless the shopper has an active abandoned cart.</p>`;
  }
  const rows = items
    .map((it) => {
      const title = it.title || it.name || 'Item';
      const qty = it.quantity || 1;
      const img = it.image
        ? `<img src="${String(it.image).replace(/"/g, '')}" alt="" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:1px solid #e2e8f0;" />`
        : `<div style="width:72px;height:72px;border-radius:12px;background:#f1f5f9;border:1px solid #e2e8f0;"></div>`;
      return `<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #f1f5f9;">${img}<div style="flex:1;"><p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">${title}</p><p style="margin:4px 0 0;font-size:12px;color:#64748b;">Qty: ${qty}</p></div></div>`;
    })
    .join('');
  return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:20px;padding:20px;margin:12px 0;">${rows}</div>`;
}

function cartTotalDisplay(lead) {
  const items = lead?.cartSnapshot?.items;
  if (!Array.isArray(items) || !items.length) return '';
  let sum = 0;
  for (const it of items) {
    const p = Number.parseFloat(it.price);
    if (!Number.isNaN(p)) sum += p * (it.quantity || 1);
  }
  if (sum <= 0) return '';
  return sum.toLocaleString('en-IN');
}

function valueForNormKey(nk, lead, client) {
  const storeName = client?.name || client?.brand?.businessName || 'Our store';
  switch (nk) {
    case 'first_name':
      return firstToken(lead?.name) || 'Customer';
    case 'name':
      return (lead?.name && String(lead.name).trim()) || 'Customer';
    case 'email':
      return lead?.email || '';
    case 'phone':
    case 'phone_number':
      return lead?.phoneNumber || '';
    case 'store_name':
      return storeName;
    case 'cart_items_html':
      return buildCartItemsHtml(lead);
    case 'cart_url':
      return lead?.abandonedCheckoutUrl || lead?.checkoutUrl || '#';
    case 'cart_total':
      return cartTotalDisplay(lead) || '—';
    case 'loyalty_points':
      return String(lead?.loyaltyPoints ?? '');
    case 'loyalty_tier':
      return lead?.loyaltyTier || '';
    default:
      return null;
  }
}

/**
 * @returns {{ subject: string, html: string, unknownTokens: string[], missingDataHints: string[] }}
 */
function mergeEmailForLead(subject, html, lead, client) {
  const combined = `${subject || ''}\n${html || ''}`;
  const rawTokens = extractTokens(combined);
  const unknownTokens = [];
  for (const t of rawTokens) {
    if (!KNOWN.has(normalizeKey(t))) unknownTokens.push(t);
  }

  const missingDataHints = [];
  for (const t of rawTokens) {
    const nk = normalizeKey(t);
    if (nk === 'cart_items_html' && (!lead?.cartSnapshot?.items || !lead.cartSnapshot.items.length)) {
      missingDataHints.push('cart_items_html (no line items — informational block is shown)');
    }
    if ((nk === 'first_name' || nk === 'name') && !(lead?.name && String(lead.name).trim())) {
      missingDataHints.push(`${nk} (using generic fallback)`);
    }
  }

  function apply(str) {
    if (!str) return '';
    let out = String(str);
    const re = new RegExp(TOKEN_RE.source, 'g');
    out = out.replace(re, (full, inner) => {
      const raw = String(inner || '').trim();
      const nk = normalizeKey(raw);
      if (!KNOWN.has(nk)) return '';
      const val = valueForNormKey(nk, lead, client);
      return val == null ? '' : String(val);
    });
    return out;
  }

  return {
    subject: apply(subject),
    html: apply(html),
    unknownTokens: [...new Set(unknownTokens)],
    missingDataHints: [...new Set(missingDataHints)]
  };
}

module.exports = {
  extractTokens,
  mergeEmailForLead,
  KNOWN_EMAIL_TOKEN_KEYS: [...KNOWN]
};
