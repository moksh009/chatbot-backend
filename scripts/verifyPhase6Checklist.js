/**
 * Phase 6 — Orders sign-off (HTTP + quick backend sanity).
 * Usage: node scripts/verifyPhase6Checklist.js --clientId=delitech_smarthomes [--token=JWT]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const token = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1];
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';
const root = path.join(__dirname, '..');

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

  if (!token) {
    console.log('⚠️  Pass --token=JWT for authenticated order routes (or run signoff4BHttp.js)\n');
    const r = spawnSync('node', [path.join(__dirname, 'archive/signoff/signoff4BHttp.js'), `--clientId=${clientId}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });
    console.log(r.status === 0 ? '✅' : '❌', 'signoff4BHttp.js');
    if (r.stdout) console.log(r.stdout.trim().split('\n').slice(-6).join('\n'));
    process.exit(r.status === 0 ? 0 : 1);
  }

  const orders = await timedGet(
    `/api/client/${clientId}/orders?statusTab=All&limit=100`,
    'orders list'
  );
  const products = await timedGet('/api/orders/products', 'orders products');
  const states = await timedGet('/api/orders/states', 'orders states');

  for (const r of [orders, products, states]) {
    const flag = r.ok && r.ms < 3000 ? '✅' : r.ok ? '🟡' : '❌';
    console.log(`${flag} ${r.label}: ${r.status || 'err'} in ${r.ms}ms`);
    if (r.error) console.log(`   ${r.error}`);
  }

  const failed = [orders, products, states].some((r) => !r.ok);
  process.exit(failed ? 1 : 0);
})();
