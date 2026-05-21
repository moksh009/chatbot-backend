/**
 * Compact documentation index for support AI (mirrors dashboard /docs).
 */

const DOC_ENTRIES = [
  { id: 'overview', title: 'Help center overview', docPath: '/docs', keywords: ['start', 'overview', 'dashboard', 'help'] },
  { id: 'setup', title: 'Setup & connections', docPath: '/docs/setup', keywords: ['setup', 'connect', 'onboarding', 'integration'] },
  { id: 'whatsapp', title: 'Connect WhatsApp', docPath: '/docs/setup#whatsapp-connect', keywords: ['whatsapp', 'waba', 'meta', 'token', 'webhook', 'phone'] },
  { id: 'shopify', title: 'Connect Shopify', docPath: '/docs/setup#shopify-connect', keywords: ['shopify', 'store', 'oauth', 'myshopify'] },
  { id: 'templates', title: 'WhatsApp templates', docPath: '/docs/templates', keywords: ['template', 'meta', 'approve', 'draft', 'ai', 'submit', 'utility', 'marketing'] },
  { id: 'template-ai', title: 'AI template drafts', docPath: '/docs/templates#ai-drafts', keywords: ['generate', 'ai draft', 'template generation'] },
  { id: 'flow', title: 'Flow Builder', docPath: '/docs/flow-builder', keywords: ['flow', 'automation', 'canvas', 'publish', 'simulator'] },
  { id: 'livechat', title: 'Live Chat', docPath: '/docs/live-chat', keywords: ['inbox', 'chat', 'handover', 'human', 'conversation'] },
  { id: 'orders', title: 'Leads & orders', docPath: '/docs/leads-orders', keywords: ['order', 'lead', 'crm'] },
  { id: 'order-auto', title: 'Order automations', docPath: '/docs/shopify-automation', keywords: ['cod', 'cart', 'abandoned', 'shipped', 'delivered', 'order message', 'automation', 'shopify automation'] },
  { id: 'campaigns', title: 'Campaigns', docPath: '/docs/campaigns', keywords: ['campaign', 'broadcast', 'marketing', 'segment'] },
  { id: 'audience', title: 'Audience & segments', docPath: '/docs/audience-hub', keywords: ['audience', 'segment', 'tag'] },
  { id: 'ecommerce', title: 'Store engine', docPath: '/docs/ecommerce', keywords: ['commerce', 'catalog', 'product', 'store engine'] },
  { id: 'intelligence', title: 'AI Brain', docPath: '/docs/intelligence-hub', keywords: ['ai', 'brain', 'knowledge', 'persona', 'intent', 'gemini', 'openai'] },
  { id: 'analytics', title: 'Analytics', docPath: '/docs/analytics', keywords: ['analytics', 'report', 'insights', 'revenue'] },
  { id: 'settings', title: 'Settings', docPath: '/docs/settings', keywords: ['settings', 'features', 'brand', 'team', 'billing', 'plan'] },
  { id: 'troubleshooting', title: 'Troubleshooting', docPath: '/docs/troubleshooting', keywords: ['error', 'fail', 'reject', 'webhook', 'token expired', 'not working'] },
];

const DOC_SUMMARIES = {
  '/docs': 'Platform overview and dashboard map.',
  '/docs/setup': 'Connect WhatsApp, Shopify, Instagram, and email.',
  '/docs/setup#whatsapp-connect': 'WABA IDs, permanent token, webhook verify.',
  '/docs/setup#shopify-connect': 'Shopify OAuth and order sync.',
  '/docs/templates': 'Create, AI-draft, submit, and sync Meta templates.',
  '/docs/templates#ai-drafts': 'Generate drafts from brand data; submit manually.',
  '/docs/flow-builder': 'Visual WhatsApp automations and publish.',
  '/docs/live-chat': 'Inbox, takeover, and team replies.',
  '/docs/shopify-automation': 'Order-triggered WhatsApp messages (COD, cart, shipped).',
  '/docs/campaigns': 'Broadcasts with approved templates.',
  '/docs/settings': 'Integrations, features toggles, brand, billing.',
  '/docs/troubleshooting': 'Common errors and fixes.',
};

function scoreEntry(entry, text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of entry.keywords) {
    if (lower.includes(kw)) score += kw.length > 6 ? 3 : 2;
  }
  if (lower.includes(entry.title.toLowerCase())) score += 4;
  return score;
}

function findRelevantDocs(userText, limit = 2) {
  const text = String(userText || '');
  if (!text.trim()) return [];
  const ranked = DOC_ENTRIES.map((e) => ({ ...e, score: scoreEntry(e, text) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked.map((e) => ({
    title: e.title,
    docPath: e.docPath,
    summary: DOC_SUMMARIES[e.docPath] || e.title,
  }));
}

function buildDocsContextForPrompt() {
  return DOC_ENTRIES.map(
    (e) => `- ${e.title}: ${e.docPath} (${e.keywords.slice(0, 6).join(', ')})`
  ).join('\n');
}

function appendDocLinks(reply, userText) {
  const base = String(reply || '').trim();
  const docs = findRelevantDocs(userText, 2);
  if (!docs.length) return base;
  const already = docs.some((d) => base.includes(d.docPath));
  if (already) return base;
  const footer = docs.map((d) => `📖 ${d.title}: ${d.docPath}`).join('\n');
  return `${base}\n\n${footer}`;
}

module.exports = {
  DOC_ENTRIES,
  findRelevantDocs,
  buildDocsContextForPrompt,
  appendDocLinks,
};
