/**
 * Audit script to find potentially unused files.
 * Run with: node scripts/auditUnusedFiles.js
 *
 * IMPORTANT: This is READ ONLY. It prints suggestions — it does NOT delete anything.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['routes', 'utils', 'services', 'workers', 'models', 'middleware'];

console.log('=== TopEdge AI File Audit ===\n');
console.log('Scanning for files with no imports...\n');

const candidates = [];

for (const dir of SOURCE_DIRS) {
  const dirPath = path.join(ROOT, dir);
  if (!fs.existsSync(dirPath)) continue;

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const fileNameNoExt = path.basename(file, '.js');

    try {
      const grepResult = execSync(
        `grep -r "${fileNameNoExt}" "${ROOT}" --include="*.js" --include="*.jsx" -l 2>/dev/null | grep -v "${filePath}" | grep -v "node_modules" | grep -v ".test." | head -5`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (!grepResult) {
        const stats = fs.statSync(filePath);
        const sizekb = Math.round(stats.size / 1024);
        candidates.push({ file: `${dir}/${file}`, size: sizekb });
        console.log(`  ⚠️  POSSIBLY UNUSED: ${dir}/${file} (${sizekb}kb)`);
      }
    } catch {
      const stats = fs.statSync(filePath);
      const sizekb = Math.round(stats.size / 1024);
      candidates.push({ file: `${dir}/${file}`, size: sizekb });
      console.log(`  ⚠️  POSSIBLY UNUSED: ${dir}/${file} (${sizekb}kb)`);
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`Found ${candidates.length} files with no detected imports.`);
console.log(`Total size: ${candidates.reduce((s, f) => s + f.size, 0)}kb`);
console.log(`\nNOTE: Review each file manually before deleting. A file may be`);
console.log(`required dynamically, or imported under a different name.`);
console.log(`\nDo NOT delete anything yet — share this output for review first.`);
