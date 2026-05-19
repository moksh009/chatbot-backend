/**
 * Phase 5 sign-off: Phase 4 HTTP checks + health/mongo pool + env hints.
 * Usage: node scripts/verifyPhase5Checklist.js [--clientId=delitech_smarthomes] [--baseUrl=http://localhost:5001]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';
const root = path.join(__dirname, '..', '..', '..');

function runNode(script, extraArgs = []) {
  const args = [path.join(__dirname, script), `--clientId=${clientId}`, ...extraArgs];
  const r = spawnSync('node', args, { cwd: root, encoding: 'utf8', timeout: 180000 });
  return {
    script,
    ok: r.status === 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

async function checkHealth() {
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = await res.json();
    const pool = body.mongoPool || {};
    const budget = body.mongoCronBudget || {};
    const mongoOk = body.services?.mongodb === 'connected';
    const ok =
      mongoOk &&
      typeof pool.configuredMaxPoolSize === 'number' &&
      (res.status === 200 || (res.status === 503 && body.services?.redis === 'not_configured'));
    return {
      ok,
      url,
      status: res.status,
      mongoPool: pool,
      mongoCronBudget: budget,
      hint: ok
        ? 'Health OK'
        : 'Start API with ./scripts/start-api-dev.sh (RUN_CRONS=false)',
    };
  } catch (e) {
    return { ok: false, url, error: e.message, hint: 'Server not reachable at ' + url };
  }
}

(async () => {
  console.log(`\n=== Phase 5 checklist (clientId=${clientId}) ===\n`);
  console.log(`Base URL: ${baseUrl}\n`);

  const health = await checkHealth();
  console.log(health.ok ? '✅' : '❌', 'GET /api/health');
  if (health.mongoPool) {
    console.log(
      `   pool max=${health.mongoPool.configuredMaxPoolSize} readyState=${health.mongoPool.readyState}` +
        (health.mongoPool.waitQueueSize != null
          ? ` waitQueue=${health.mongoPool.waitQueueSize}`
          : '')
    );
  }
  if (!health.ok) console.log(`   ${health.hint || health.error}\n`);

  const phase4 = runNode('../../verifyPhase4Checklist.js', ['--skipSend']);
  console.log(phase4.ok ? '✅' : '❌', 'verifyPhase4Checklist.js (--skipSend)');
  if (phase4.stdout) console.log(phase4.stdout.split('\n').slice(-6).join('\n'));
  console.log('');

  console.log('Manual (4D WhatsApp):');
  console.log('  1. RUN_CRONS=false on API dyno, workers on separate process');
  console.log('  2. Send "hi" on WhatsApp → Live Chat <3s, log has message_saved_early');
  console.log('');

  const failed = !health.ok || !phase4.ok;
  process.exit(failed ? 1 : 0);
})();
