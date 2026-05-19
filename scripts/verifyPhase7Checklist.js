/**
 * Phase 7 — Flow Builder sign-off (static FE checks + optional HTTP).
 * Usage: node scripts/verifyPhase7Checklist.js [--clientId=delitech_smarthomes] [--token=JWT] [--baseUrl=http://localhost:5001]
 */
const fs = require('fs');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const token = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1];
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';

const root = path.join(__dirname, '..');
const feRoot = path.join(root, '..', 'chatbot-dashboard-frontend-main');
const flowBuilderPath = path.join(feRoot, 'src/pages/FlowBuilder.jsx');

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
    return { label, ok: res.ok, status: res.status, ms, body, headers: res.headers };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - t0, error: e.message };
  }
}

(async () => {
  console.log(`\n=== Phase 7 Flow Builder checklist (${clientId}) ===\n`);

  let failed = 0;

  console.log('--- Frontend static ---');
  if (!fs.existsSync(flowBuilderPath)) {
    staticCheck('FlowBuilder.jsx present', false, flowBuilderPath);
    failed += 1;
  } else {
    const src = fs.readFileSync(flowBuilderPath, 'utf8');
    const checks = [
      ['lazy OnboardingWizard', /lazy\(\s*\(\)\s*=>\s*import\(['"]\.\/OnboardingWizard['"]\)/.test(src)],
      ['heatmap: no poll when socket connected', /if\s*\(\s*socket\?\.connected\s*\)/.test(src) && /setInterval\(fetchObservability,\s*15000\)/.test(src)],
      ['lite flows bootstrap', /\/flow\/flows\?[^'"]*lite=1/.test(src)],
      ['graph on demand', /\/flow\/flows\/\$\{encodeURIComponent\(targetFlowId\)\}\/graph/.test(src)],
    ];
    for (const [label, ok] of checks) {
      if (!staticCheck(label, ok)) failed += 1;
    }
  }

  const flowJs = path.join(root, 'routes/flow.js');
  const analyticsJs = path.join(root, 'routes/analytics.js');
  if (fs.existsSync(flowJs)) {
    const flowSrc = fs.readFileSync(flowJs, 'utf8');
    if (!staticCheck('GET /api/flow/ deprecated lite (no nodes in map)', /X-Deprecated-Endpoint/.test(flowSrc) && /nodeCount:\s*Array\.isArray\(f\.nodes\)/.test(flowSrc))) {
      failed += 1;
    }
    if (!staticCheck('summary apiCache + dedupe', /\/:flowId\/summary['"],\s*protect,\s*apiCache/.test(flowSrc) && /flow-summary:/.test(flowSrc))) {
      failed += 1;
    }
  }
  if (fs.existsSync(analyticsJs)) {
    const aSrc = fs.readFileSync(analyticsJs, 'utf8');
    if (!staticCheck('flow-observability apiCache + dedupe', /\/flow-observability['"],\s*protect,\s*apiCache/.test(aSrc) && /flow-observability:/.test(aSrc))) {
      failed += 1;
    }
  }

  console.log('\n--- HTTP (optional; pass --token=JWT) ---');
  if (!token) {
    console.log('⚠️  Skipping authenticated routes (pass --token=JWT)\n');
    process.exit(failed ? 1 : 0);
  }

  const liteFlows = await timedGet(
    `/api/flow/flows?clientId=${encodeURIComponent(clientId)}&lite=1`,
    'GET /api/flow/flows?lite=1'
  );
  const deprecatedRoot = await timedGet('/api/flow/', 'GET /api/flow/ (deprecated)');
  const observability = await timedGet(
    `/api/analytics/flow-observability?clientId=${encodeURIComponent(clientId)}&minutes=60`,
    'GET /api/analytics/flow-observability'
  );

  for (const r of [liteFlows, deprecatedRoot, observability]) {
    const flag = r.ok && r.ms < 5000 ? '✅' : r.ok ? '🟡' : '❌';
    console.log(`${flag} ${r.label}: ${r.status || 'err'} in ${r.ms}ms`);
    if (r.error) console.log(`   ${r.error}`);
    if (!r.ok) failed += 1;
  }

  if (deprecatedRoot.ok && Array.isArray(deprecatedRoot.body?.flows)) {
    const hasHeavyNodes = deprecatedRoot.body.flows.some(
      (f) => Array.isArray(f.nodes) && f.nodes.length > 0
    );
    if (!staticCheck('deprecated /flow/ has no nodes[] payloads', !hasHeavyNodes)) failed += 1;
    if (deprecatedRoot.headers?.get?.('x-deprecated-endpoint')) {
      staticCheck('X-Deprecated-Endpoint header', true);
    }
  }

  const firstFlowId =
    liteFlows.body?.flows?.[0]?.id ||
    liteFlows.body?.flows?.[0]?.flowId ||
    deprecatedRoot.body?.flows?.[0]?.id;
  if (firstFlowId) {
    const summary = await timedGet(`/api/flow/${encodeURIComponent(firstFlowId)}/summary`, 'flow summary');
    const versions = await timedGet(`/api/flow/${encodeURIComponent(firstFlowId)}/versions`, 'flow versions');
    for (const r of [summary, versions]) {
      const flag = r.ok && r.ms < 3000 ? '✅' : r.ok ? '🟡' : '❌';
      console.log(`${flag} ${r.label}: ${r.status || 'err'} in ${r.ms}ms`);
      if (!r.ok) failed += 1;
    }
  }

  console.log(failed ? `\n❌ ${failed} check(s) failed\n` : '\n✅ Phase 7 checklist passed\n');
  process.exit(failed ? 1 : 0);
})();
