/**
 * Smoke load script — requires k6: https://k6.io/docs/getting-started/installation/
 *
 * Usage:
 *   k6 run scripts/load/k6-smoke.js
 *   BASE_URL=https://your-api.onrender.com k6 run scripts/load/k6-smoke.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000']
  }
};

export default function () {
  const res = http.get(`${BASE}/api/health`);
  check(res, {
    'health status 200 or 503': (r) => r.status === 200 || r.status === 503
  });
  sleep(1);
}
