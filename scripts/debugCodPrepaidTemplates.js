'use strict';

require('dotenv').config({ path: '.env' });
require('dotenv').config({ path: '.env.local', override: true });

const mongoose = require('mongoose');
const MetaTemplate = require('../models/MetaTemplate');

function collectButtons(t) {
  const rows = [];
  const comp = (t.components || []).find((c) => String(c.type || '').toUpperCase() === 'BUTTONS');
  if (comp?.buttons?.length) rows.push(...comp.buttons);
  if (Array.isArray(t.formData?.buttons)) rows.push(...t.formData.buttons);
  if (Array.isArray(t.buttons)) rows.push(...t.buttons);
  return rows;
}

function isUrl(btn) {
  return String(btn?.type || btn?.buttonType || '').toUpperCase() === 'URL';
}

function isStaticUrl(btn) {
  if (!isUrl(btn)) return false;
  if (String(btn.urlType || '').toLowerCase() === 'dynamic') return false;
  const url = String(btn.url || '').trim();
  return url && !/\{\{/.test(url);
}

function isDynamicUrl(btn) {
  if (!isUrl(btn)) return false;
  if (btn.urlVariable) return true;
  if (String(btn.urlType || '').toLowerCase() === 'dynamic') return true;
  const url = String(btn.url || '').trim();
  return url && /\{\{/.test(url);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const clientId = process.argv[2] || '';
  const query = clientId ? { clientId } : {};
  const rows = await MetaTemplate.find(query).select('name status clientId components formData buttons').lean();
  const approved = rows.filter((t) => ['APPROVED', 'approved', 'ACTIVE'].includes(String(t.status || '').toUpperCase())
    || String(t.status || '').toLowerCase() === 'approved');

  let staticCount = 0;
  let dynamicCount = 0;
  let noUrl = 0;

  for (const t of approved) {
    const btns = collectButtons(t);
    const urlBtns = btns.filter(isUrl);
    if (!urlBtns.length) {
      noUrl += 1;
      continue;
    }
    if (urlBtns.some(isStaticUrl)) staticCount += 1;
    else if (urlBtns.some(isDynamicUrl)) dynamicCount += 1;
    else noUrl += 1;
  }

  console.log(JSON.stringify({
    clientId: clientId || '(all)',
    total: rows.length,
    approved: approved.length,
    withStaticUrl: staticCount,
    withDynamicUrlOnly: dynamicCount,
    withoutUrlButton: noUrl,
    samples: approved.slice(0, 8).map((t) => ({
      name: t.name,
      status: t.status,
      buttons: collectButtons(t).map((b) => ({
        type: b.type || b.buttonType,
        urlType: b.urlType,
        url: b.url,
        urlVariable: b.urlVariable,
      })),
    })),
  }, null, 2));

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
