const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function testNoBroadcastCampaign() {
  const src = fs.readFileSync(path.join(ROOT, 'services/TaskWorker.js'), 'utf8');
  assert.ok(!src.includes('BROADCAST_CAMPAIGN'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'utils/commerce/broadcastEngine.js')));
}

function testNo101080() {
  const src = fs.readFileSync(path.join(ROOT, 'routes/campaigns.js'), 'utf8');
  assert.ok(!src.includes('10/10/80'));
  assert.ok(!src.includes('holdbackSizePct'));
}

function testCancelRoute() {
  const src = fs.readFileSync(path.join(ROOT, 'routes/campaigns.js'), 'utf8');
  assert.ok(src.includes("/:id/cancel"));
  assert.ok(src.includes('merchant_cancelled'));
  assert.ok(src.includes('campaign:cancelled'));
}

let failed = 0;
for (const [name, fn] of [
  ['noBroadcastCampaign', testNoBroadcastCampaign],
  ['no101080', testNo101080],
  ['cancelRoute', testCancelRoute],
]) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`✗ ${name}:`, e.message);
  }
}
process.exit(failed ? 1 : 0);
