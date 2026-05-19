/**
 * Phase 4B Orders HTTP sign-off — list + filter endpoints.
 * Usage: node scripts/signoff4BHttp.js [--clientId=delitech_smarthomes]
 */
const { loadSignoffEnv, requireFromRoot } = require('../../_lib/signoffEnv');
loadSignoffEnv();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = process.env.SIGNOFF_API_BASE || 'http://localhost:5001/api';

async function req(method, urlPath, token) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ms, count: data.orders?.length ?? data.products?.length ?? data.states?.length };
}

async function run() {
  const clientId =
    process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = requireFromRoot('models/User');
  const user = await User.findOne({ clientId }).select('_id role clientId').lean();
  if (!user) throw new Error(`No user for clientId=${clientId}`);

  const token = jwt.sign(
    { id: user._id, clientId: user.clientId, role: user.role || 'CLIENT_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const orders1 = await req('GET', `/client/${clientId}/orders?statusTab=All`, token);
  const orders2 = await req('GET', `/client/${clientId}/orders?statusTab=All`, token);
  const products1 = await req('GET', '/orders/products', token);
  const products2 = await req('GET', '/orders/products', token);
  const states1 = await req('GET', '/orders/states', token);

  const report = {
    clientId,
    orders1Ms: orders1.ms,
    orders2Ms: orders2.ms,
    orders2CacheTarget: orders2.ms < 500,
    products1Ms: products1.ms,
    products2Ms: products2.ms,
    products2CacheTarget: products2.ms < 500,
    states1Ms: states1.ms,
    orderCount: orders1.count,
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();

  const pass =
    orders1.status === 200 &&
    orders2.status === 200 &&
    orders2.ms < 500 &&
    products1.status === 200 &&
    products2.status === 200 &&
    products2.ms < 500;

  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
