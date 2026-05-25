/**
 * Audit script to find potentially unused source files.
 * Run with: node scripts/auditUnusedFiles.js
 *
 * READ ONLY — prints suggestions; does not delete anything.
 *
 * Method:
 * 1. Recursively list .js under routes, utils, services, workers, models, middleware, controllers, cron
 * 2. Build static require/import graph from all project .js (relative paths only)
 * 3. Flag modules not reachable from entry points (index.js, app.js, server.js)
 * 4. Classify: path-unreferenced vs basename-only false positives (enum/field name collisions)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = [
  'routes',
  'utils/meta',
  'utils/shopify',
  'utils/flow',
  'utils/commerce',
  'utils/core',
  'services',
  'workers',
  'models',
  'middleware',
  'controllers',
  'cron',
];
const ENTRY_FILES = ['index.js', 'app.js', 'server.js'];
const SKIP_DIR = new Set(['node_modules', '.git', 'coverage', 'dist']);

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walkJs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, acc);
    else if (ent.name.endsWith('.js') && !/\.test\./.test(ent.name)) acc.push(p);
  }
  return acc;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const asFile = base.endsWith('.js') ? base : `${base}.js`;
  const asIndex = path.join(base, 'index.js');

  // Prefer .js file over an empty sibling directory (e.g. routes/analytics vs analytics.js)
  if (fs.existsSync(asFile) && fs.statSync(asFile).isFile()) return rel(asFile);
  if (fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) return rel(asIndex);
  if (fs.existsSync(base) && fs.statSync(base).isDirectory() && fs.existsSync(asIndex)) {
    return rel(asIndex);
  }
  return null;
}

const IMPORT_RE = [
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:import|export)\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function collectImports(filePath, text) {
  const specs = [];
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) specs.push(m[1]);
  }
  return specs;
}

function pathReferenceHits(targetRel, allFiles, contents) {
  const hits = [];
  const base = path.basename(targetRel, '.js');
  const posix = targetRel.replace(/\\/g, '/');
  const noExt = posix.replace(/\.js$/, '');

  for (const [file, text] of contents) {
    if (file === targetRel) continue;
    if (
      text.includes(`'${posix}'`) ||
      text.includes(`"${posix}"`) ||
      text.includes(`'${noExt}'`) ||
      text.includes(`"${noExt}"`) ||
      text.includes(`'./${base}'`) ||
      text.includes(`"./${base}"`) ||
      text.includes(`'../${base}'`) ||
      text.includes(`"../${base}"`)
    ) {
      hits.push(file);
    }
  }
  return hits.slice(0, 5);
}

function main() {
  const t0 = Date.now();
  const allProjectJs = walkJs(ROOT);
  const contents = new Map(
    allProjectJs.map((f) => [rel(f), fs.readFileSync(f, 'utf8')])
  );

  const sourceFiles = [];
  for (const dir of SOURCE_DIRS) {
    walkJs(path.join(ROOT, dir), sourceFiles);
  }

  const referenced = new Set();
  for (const entry of ENTRY_FILES) {
    const p = path.join(ROOT, entry);
    if (fs.existsSync(p)) referenced.add(entry);
  }

  for (const [fileRel, text] of contents) {
    const abs = path.join(ROOT, fileRel);
    for (const spec of collectImports(abs, text)) {
      const resolved = resolveImport(abs, spec);
      if (resolved) referenced.add(resolved);
    }
  }

  const candidates = [];
  for (const abs of sourceFiles) {
    const fileRel = rel(abs);
    if (referenced.has(fileRel)) continue;

    const sizekb = Math.round(fs.statSync(abs).size / 1024);
    const text = contents.get(fileRel) || '';
    const pathHits = pathReferenceHits(fileRel, contents, contents);
    const base = path.basename(fileRel, '.js');
    let basenameOnly = false;
    if (pathHits.length === 0) {
      for (const [f, t] of contents) {
        if (f === fileRel) continue;
        if (t.includes(base)) {
          basenameOnly = true;
          break;
        }
      }
    }

    const isCli = text.includes('require.main === module');
    candidates.push({
      file: fileRel,
      size: sizekb,
      pathHits,
      basenameOnly,
      isCli,
    });
  }

  candidates.sort((a, b) => a.file.localeCompare(b.file));

  console.log('=== TopEdge AI File Audit ===\n');
  console.log(`Scanned ${sourceFiles.length} source files (recursive) in ${Date.now() - t0}ms\n`);

  const tierA = candidates.filter((c) => !c.pathHits.length && !c.basenameOnly && !c.isCli);
  const tierB = candidates.filter((c) => !c.pathHits.length && c.basenameOnly && !c.isCli);
  const tierC = candidates.filter((c) => c.isCli);
  const tierD = candidates.filter((c) => c.pathHits.length);

  if (tierA.length) {
    console.log('Tier A — Not in import graph, no path/basename refs (review for delete):\n');
    for (const c of tierA) {
      console.log(`  ⚠️  ${c.file} (${c.size}kb)`);
    }
    console.log('');
  }

  if (tierB.length) {
    console.log('Tier B — Not in import graph; basename collision only (verify before delete):\n');
    for (const c of tierB) {
      console.log(`  ⚠️  ${c.file} (${c.size}kb)  [basename "${path.basename(c.file, '.js')}" appears elsewhere]`);
    }
    console.log('');
  }

  if (tierC.length) {
    console.log('Tier C — CLI scripts (require.main); not imported at runtime:\n');
    for (const c of tierC) {
      console.log(`  ℹ️  ${c.file} (${c.size}kb)`);
    }
    console.log('');
  }

  if (tierD.length) {
    console.log('Tier D — Not in import graph but path string referenced (dynamic/fs — keep):\n');
    for (const c of tierD) {
      console.log(`  ℹ️  ${c.file} (${c.size}kb)  refs: ${c.pathHits.join(', ')}`);
    }
    console.log('');
  }

  const purgeCandidates = [...tierA, ...tierB];
  console.log('=== Summary ===');
  console.log(`Unreachable from entry graph: ${candidates.length}`);
  console.log(`Tier A (safest): ${tierA.length} | Tier B (verify): ${tierB.length} | CLI: ${tierC.length} | Dynamic: ${tierD.length}`);
  console.log(`Tier A+B size: ${purgeCandidates.reduce((s, f) => s + f.size, 0)}kb`);
  console.log('\nNOTE: Review Tier B manually — basename may be enum/field names.');
  console.log('Do NOT delete until reviewed.');
}

main();
