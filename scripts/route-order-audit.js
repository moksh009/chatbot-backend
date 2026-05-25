#!/usr/bin/env node
/**
 * Flags Express routes where a parameterized path may shadow a static segment.
 * Run: node scripts/route-order-audit.js
 */
const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '../routes');
const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));

const routeRe = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;

for (const file of files) {
  const text = fs.readFileSync(path.join(routesDir, file), 'utf8');
  const routes = [];
  let m;
  while ((m = routeRe.exec(text)) !== null) {
    routes.push({ method: m[1], path: m[2], index: m.index });
  }
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const hasParam = r.path.includes(':');
    if (!hasParam) continue;
    const segments = r.path.split('/').filter(Boolean);
    const paramIdx = segments.findIndex((s) => s.startsWith(':'));
    if (paramIdx < 0) continue;
    for (let j = i + 1; j < routes.length; j++) {
      const later = routes[j];
      if (later.method !== r.method) continue;
      const laterSegs = later.path.split('/').filter(Boolean);
      if (laterSegs.length !== segments.length) continue;
      let shadowed = true;
      for (let k = 0; k < segments.length; k++) {
        if (segments[k].startsWith(':')) continue;
        if (laterSegs[k] !== segments[k]) {
          shadowed = false;
          break;
        }
      }
      if (shadowed && !later.path.includes(':')) {
        console.warn(`[shadow] ${file}: ${r.method.toUpperCase()} ${r.path} may shadow ${later.method.toUpperCase()} ${later.path}`);
      }
    }
  }
}

console.log('Route order audit complete.');
