#!/usr/bin/env node
/**
 * Plan A: Full backend system audit → docs/SYSTEM_AUDIT_REPORT.md
 * Usage: node scripts/runSystemAudit.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'docs/SYSTEM_AUDIT_REPORT.md');

function listJs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    if (ent.isDirectory()) listJs(p, acc);
    else if (ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function countPattern(files, re) {
  let n = 0;
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    const m = t.match(re);
    if (m) n += m.length;
  }
  return n;
}

function routeFiles() {
  const dir = path.join(ROOT, 'routes');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => `routes/${f}`);
}

function cronFiles() {
  const dir = path.join(ROOT, 'cron');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => `cron/${f}`);
}

function findLogArtifacts() {
  const bad = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.log$/i.test(ent.name) || ent.name === 'model.nlp' && d === ROOT) {
        const rel = path.relative(ROOT, p);
        if (!rel.startsWith('node_modules')) bad.push(rel);
      }
    }
  };
  walk(ROOT);
  return bad.filter((f) => !f.includes('node_modules'));
}

function scriptsInventory() {
  const dir = path.join(ROOT, 'scripts');
  const active = [];
  const archive = [];
  const walk = (d, prefix = '') => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === 'archive') {
          archive.push(...fs.readdirSync(path.join(d, ent.name)).filter((x) => x.endsWith('.js')).map((x) => `archive/${x}`));
        } else walk(path.join(d, ent.name), rel);
      } else if (ent.name.endsWith('.js') || ent.name.endsWith('.sh')) {
        active.push(rel);
      }
    }
  };
  walk(dir);
  return { active, archive };
}

function main() {
  const allJs = listJs(ROOT);
  const routes = routeFiles();
  const crons = cronFiles();
  const apiCacheUses = countPattern(
    allJs.filter((f) => f.includes('/routes/')),
    /apiCache\s*\(/g
  );
  const getCachedUses = countPattern(allJs, /getCachedClient/g);
  const dedupeUses = countPattern(allJs, /dedupeAsync|dedupeBootstrap|getBootstrapPayload/g);
  const logs = findLogArtifacts();
  const { active: scripts, archive: archivedScripts } = scriptsInventory();

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const npmScripts = Object.keys(pkg.scripts || {});

  const lines = [
    '# System audit report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Route files | ${routes.length} |`,
    `| Cron modules | ${crons.length} |`,
    `| \`apiCache(\` in routes | ${apiCacheUses} |`,
    `| \`getCachedClient\` refs | ${getCachedUses} |`,
    `| Dedupe/cache helpers | ${dedupeUses} |`,
    `| Active scripts | ${scripts.length} |`,
    `| Log artifacts in tree | ${logs.length} |`,
    '',
    '## Environment (dev)',
    '',
    '- **Use:** `./scripts/start-api-dev.sh` (`RUN_CRONS=false`, `RUN_WORKERS=false`)',
    '- **Avoid:** `PERF_LOGGING=true node index.js` for UI testing — crons compete for Mongo pool',
    '',
    '## Cron modules',
    '',
    ...crons.map((c) => `- \`${c}\``),
    '',
    '## Route files',
    '',
    ...routes.map((r) => `- \`${r}\``),
    '',
    '## Log / noise files (remove from git, already in .gitignore)',
    '',
    logs.length ? logs.map((l) => `- \`${l}\``).join('\n') : '- _(none found)_',
    '',
    '## npm scripts (CI)',
    '',
    ...npmScripts.map((s) => `- \`npm run ${s}\``),
    '',
    '## Active scripts (top-level)',
    '',
    ...scripts.filter((s) => !s.includes('/')).sort().map((s) => `- \`scripts/${s}\``),
    '',
    '## Performance verify scripts',
    '',
    '- `verifyAllPhases.js` — runs phase 5–11 checklists',
    '- `verifyPerfHotpaths.js` — bootstrap, catalog, wa-flows timing',
    '',
    '## Plan B gaps (manual follow-up)',
    '',
    'Routes to review for `apiCache` + perf timers on hot GETs:',
    '- `routes/templates.js` — list/sync',
    '- `routes/knowledge.js` — RAG queries',
    '- `routes/segments.js` — segment leads',
    '- `routes/settings.js` / heavy admin GETs',
    '',
    '## Plan D — Chatbot env',
    '',
    '```env',
    'INBOUND_QUEUE_DEBOUNCE_MS=300',
    'INBOUND_QUEUE_FIRST_FLUSH_MS=0',
    'CLIENT_CACHE_TTL_SEC=30',
    'BOOTSTRAP_CACHE_TTL_SEC=45',
    '```',
    '',
  ];

  fs.writeFileSync(REPORT, lines.join('\n'));
  console.log(`\n✅ Wrote ${path.relative(ROOT, REPORT)}\n`);
  console.log(`Routes: ${routes.length} | Crons: ${crons.length} | Log files: ${logs.length}`);
  if (logs.length) {
    console.log('\n⚠️  Remove these from workspace (not needed in repo):');
    logs.forEach((l) => console.log('   ', l));
  }
  console.log('\nNext: Plan B — say **continue** to audit API cache on remaining hot routes.\n');
}

main();
