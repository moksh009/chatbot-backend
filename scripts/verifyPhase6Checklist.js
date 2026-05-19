/**
 * Phase 6 — Orders sign-off (static + optional HTTP).
 * Usage: node scripts/verifyPhase6Checklist.js --clientId=delitech_smarthomes [--token=JWT] [--http]
 */
const fs = require('fs');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const token = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1];
const wantHttp = process.argv.includes('--http') || Boolean(token);
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';

const root = path.join(__dirname, '..');
const feRoot = path.join(root, '..', 'chatbot-dashboard-frontend-main');
const ordersPath = path.join(feRoot, 'src/pages/Orders.jsx');

function staticCheck(label, ok, detail = '') {
  const flag = ok ? '✅' : '❌';
  console.log(`${flag} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function timedGet(urlPath, label) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${baseUrl.replace(/\/$/, '')}${urlPath}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    const ms = Date.now() - t0;
    const body = await res.json().catch(() => ({}));
    return { label, ok: res.ok, status: res.status, ms, body };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - t0, error: e.message };
  }
}

(async () => {
  console.log(`\n=== Phase 6 Orders checklist (${clientId}) ===\n`);

  let failed = 0;

  console.log('--- Frontend static ---');
  if (!fs.existsSync(ordersPath)) {
    if (!staticCheck('Orders.jsx present', false)) failed += 1;
  } else {
    const src = fs.readFileSync(ordersPath, 'utf8');
    const checks = [
      ['useQuery orders + signal', /useQuery\([\s\S]*?queryFn:\s*async\s*\(\{\s*signal\s*\}\)/.test(src) && /signal,/.test(src)],
      ['staleTime 60s', /staleTime:\s*60_000/.test(src)],
      ['search debounce 400ms', /setDebouncedSearch\(searchTerm\.trim\(\)\),\s*400/.test(src)],
      ['Signals tab deferred leads', /viewMode\s*!==\s*['"]Signals['"]/.test(src) && /AbortController/.test(src)],
      ['isRequestCanceled', /isRequestCanceled/.test(src)],
      ['lazy RTOAnalytics', /lazy\(\s*\(\)\s*=>\s*import\(['"]\.\.\/components\/RTOAnalytics['"]\)/.test(src)],
      ['lazy filter meta', /needFilterMeta/.test(src)],
    ];
    for (const [label, ok] of checks) {
      if (!staticCheck(label, ok)) failed += 1;
    }
  }

  console.log('\n--- Backend static ---');
  const ordersJs = path.join(root, 'routes/orders.js');
  const genericJs = path.join(root, 'routes/engines/genericEcommerce.js');
  const analyticsJs = path.join(root, 'routes/analytics.js');
  if (fs.existsSync(ordersJs)) {
    const o = fs.readFileSync(ordersJs, 'utf8');
    if (!staticCheck('orders/products + states routes', /\/orders\/products/.test(o) && /getDistinctOrderStates/.test(o))) {
      failed += 1;
    }
  }
  if (fs.existsSync(genericJs)) {
    const g = fs.readFileSync(genericJs, 'utf8');
    if (!staticCheck('getClientOrders cap 150 + dedupe', /fetchLimit\s*=\s*150/.test(g) && /dedupeAsync/.test(g))) {
      failed += 1;
    }
  }
  if (fs.existsSync(analyticsJs)) {
    const a = fs.readFileSync(analyticsJs, 'utf8');
    if (
      !staticCheck(
        'lead-intelligence uses leadScore',
        /\/lead-intelligence/.test(a) && /leadScore:\s*\{\s*\$gte:\s*100\s*\}/.test(a)
      )
    ) {
      failed += 1;
    }
  }

  if (!wantHttp) {
    console.log('\n--- HTTP (optional) ---');
    console.log('⚠️  Pass --token=JWT or --http to hit live order routes\n');
    process.exit(failed ? 1 : 0);
  }

  console.log('\n--- HTTP ---');
  const orders = await timedGet(
    `/api/client/${clientId}/orders?statusTab=All&limit=100`,
    'orders list'
  );
  const products = await timedGet(
    `/api/orders/products?clientId=${encodeURIComponent(clientId)}`,
    'orders products'
  );
  const states = await timedGet(
    `/api/orders/states?clientId=${encodeURIComponent(clientId)}`,
    'orders states'
  );

  for (const r of [orders, products, states]) {
    const flag = r.ok && r.ms < 3000 ? '✅' : r.ok ? '🟡' : '❌';
    console.log(`${flag} ${r.label}: ${r.status || 'err'} in ${r.ms}ms`);
    if (r.error) console.log(`   ${r.error}`);
    if (!r.ok) failed += 1;
  }

  console.log(failed ? `\n❌ ${failed} check(s) failed\n` : '\n✅ Phase 6 checklist passed\n');
  process.exit(failed ? 1 : 0);
})();
