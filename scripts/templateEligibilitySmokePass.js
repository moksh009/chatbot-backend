#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendRoot = path.join(repoRoot, 'chatbot-backend-main');
const frontendRoot = path.join(repoRoot, 'chatbot-dashboard-frontend-main');

const checks = [];
const failures = [];

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function assertContains(filePath, mustContain, label) {
  const content = read(filePath);
  const ok = mustContain.every((token) => content.includes(token));
  checks.push({ label, ok });
  if (!ok) {
    failures.push(`${label} failed in ${filePath}`);
  }
}

function walk(dir, bucket) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
      walk(full, bucket);
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      bucket.push(full);
    }
  }
}

function assertNoDeprecatedAutomationPath() {
  const files = [];
  walk(frontendRoot, files);
  const offenders = [];
  for (const file of files) {
    const content = read(file);
    if (content.includes('/automation/sequences') || content.includes('/api/automation')) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  const ok = offenders.length === 0;
  checks.push({ label: 'No deprecated /automation sequences paths in frontend', ok });
  if (!ok) {
    failures.push(`Deprecated automation sequence path found in: ${offenders.join(', ')}`);
  }
}

function run() {
  assertContains(
    path.join(backendRoot, 'utils/templateEligibility.js'),
    ['validateTemplateEligibility', 'normalizePurpose', 'requiredVariableCount'],
    'Shared template eligibility utility exists'
  );
  assertContains(
    path.join(backendRoot, 'routes/campaigns.js'),
    ['validateTemplateEligibility', 'contextPurpose: \'campaign\'', '[QuickSend][TemplatePreflightFailed]'],
    'Campaign routes use strict preflight checks'
  );
  assertContains(
    path.join(backendRoot, 'routes/sequences.js'),
    ['validateTemplateEligibility', 'contextPurpose: \'sequence\'', 'TemplatePreflightFailed'],
    'Sequence routes use strict preflight checks'
  );
  assertContains(
    path.join(backendRoot, 'utils/validator.js'),
    ['contextPurpose: \'flow\'', 'validateTemplateEligibility'],
    'Flow node validator enforces template eligibility'
  );
  assertContains(
    path.join(backendRoot, 'models/MetaTemplate.js'),
    ['primaryPurpose', 'secondaryPurposes'],
    'MetaTemplate includes purpose tagging fields'
  );
  assertContains(
    path.join(backendRoot, 'routes/templates.js'),
    ['contextPurpose', 'primaryPurpose', 'secondaryPurposes'],
    'Template list endpoint supports context purpose filtering'
  );
  assertContains(
    path.join(frontendRoot, 'src/components/ui/TemplateDropdown.jsx'),
    ['contextPurpose', 'Show all templates', '/templates/list?clientId='],
    'TemplateDropdown supports guarded context filtering'
  );
  assertContains(
    path.join(frontendRoot, 'src/pages/CampaignManager.jsx'),
    ['TemplateDropdown', 'contextPurpose="campaign"'],
    'CampaignManager uses guarded template picker'
  );
  assertContains(
    path.join(frontendRoot, 'src/components/SequenceBuilder.jsx'),
    ['selectedMetaReady', 'approvedWaTemplates'],
    'SequenceBuilder has launch guardrails'
  );
  assertContains(
    path.join(frontendRoot, 'src/pages/FlowBuilder.jsx'),
    ['/templates/list?clientId=', 'contextPurpose=flow'],
    'FlowBuilder reads context-scoped template list'
  );
  assertNoDeprecatedAutomationPath();

  console.log('Template Eligibility Smoke Pass');
  console.log('--------------------------------');
  checks.forEach((c) => {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.label}`);
  });
  console.log('--------------------------------');
  if (failures.length) {
    console.error('Failures:');
    failures.forEach((f) => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log(`All ${checks.length} checks passed.`);
}

run();
