'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function grepNoOnboardingWizardRuntime() {
  const hits = [];
  const skip = ['docs/', 'scripts/migrations/', 'node_modules/'];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (skip.some((s) => p.includes(s))) continue;
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.js') && !name.includes('onboarding-final-migration')) {
        const txt = fs.readFileSync(p, 'utf8');
        if (txt.includes('OnboardingWizard') && !txt.includes('OnboardingWizard collection')) {
          hits.push(p.replace(ROOT, ''));
        }
      }
    }
  }
  walk(ROOT);
  return hits;
}

function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'models/ProductWatch.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'services/training/trainingOutcomeTracker.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'services/productWatch/triggerRestockNotifications.js')));
  assert.ok(read('routes/training.js').includes('/cases/:id/approve'));
  assert.ok(read('utils/commerce/dualBrainEngine.js').includes('trainingContext'));
  assert.ok(read('utils/commerce/dualBrainEngine.js').includes('pendingProductWatch'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'models/OnboardingWizard.js')));
  const wizHits = grepNoOnboardingWizardRuntime();
  assert.strictEqual(wizHits.length, 0, `OnboardingWizard refs: ${wizHits.join(', ')}`);
  console.log('✓ phase6Closeout smoke passed');
}

main();
