#!/usr/bin/env node
'use strict';

/**
 * Phase 2 split-deploy kit smoke — verifies scripts and boot env contract exist.
 * Does not connect to Mongo/Redis; safe for CI.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');

function read(rel) {
  const p = path.join(root, rel);
  assert.ok(fs.existsSync(p), `missing ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

const apiSh = read('scripts/start-api-prod.sh');
assert.match(apiSh, /RUN_API=true/);
assert.match(apiSh, /RUN_CRONS=false/);
assert.match(apiSh, /RUN_WORKERS=false/);
assert.match(apiSh, /CHATBOT_PROCESS_ROLE=api/);

const workerSh = read('scripts/start-worker-prod.sh');
assert.match(workerSh, /RUN_API=false/);
assert.match(workerSh, /RUN_CRONS=true/);
assert.match(workerSh, /RUN_WORKERS=true/);
assert.match(workerSh, /CHATBOT_PROCESS_ROLE=worker/);

const patchSh = read('scripts/patch-env-split-deploy.sh');
assert.match(patchSh, /api\|worker\|strip/);

const envExample = read('.env.example');
assert.match(envExample, /RUN_API=/);
assert.match(envExample, /RUN_CRONS=/);
assert.match(envExample, /RUN_WORKERS=/);
assert.match(envExample, /start-api-/);

assert.ok(fs.existsSync(path.join(root, 'scripts/start-api-prod.sh')));
assert.ok(fs.existsSync(path.join(root, 'scripts/start-worker-prod.sh')));
assert.ok(fs.existsSync(path.join(root, 'scripts/apply-split-deploy-contabo.sh')));
assert.ok(fs.existsSync(path.join(root, 'scripts/repair-prod-deps.sh')));
assert.ok(fs.existsSync(path.join(root, 'ecosystem.config.cjs')));

const repairSh = read('scripts/repair-prod-deps.sh');
assert.match(repairSh, /npm ci --omit=dev/);
assert.match(repairSh, /integration-probe/);

const ecosystem = read('ecosystem.config.cjs');
assert.match(ecosystem, /topedge-api/);
assert.match(ecosystem, /topedge-worker/);
assert.match(ecosystem, /RUN_API.*true/);

const applySh = read('scripts/apply-split-deploy-contabo.sh');
assert.match(applySh, /both/);
assert.match(applySh, /ecosystem\.config\.cjs/);

const indexJs = read('index.js');
assert.match(indexJs, /RUN_API/);
assert.match(indexJs, /RUN_CRONS/);
assert.match(indexJs, /RUN_WORKERS/);
assert.match(indexJs, /SUPPRESS_SPLIT_DEPLOY_WARN/);

console.log('✓ verify-split-deploy-kit passed');
