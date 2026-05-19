/**
 * Phase 4C Flow Builder HTTP sign-off.
 * Usage: node scripts/signoff4C.js [--clientId=delitech_smarthomes]
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
  const cache = res.headers.get('x-cache');
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ms, cache, data };
}

async function run() {
  const clientId =
    process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = requireFromRoot('models/User');
  const WhatsAppFlow = requireFromRoot('models/WhatsAppFlow');
  const user = await User.findOne({ clientId }).lean();
  if (!user) throw new Error(`No user for ${clientId}`);

  const token = jwt.sign(
    { id: user._id, clientId: user.clientId, role: user.role || 'CLIENT_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const list1 = await req('GET', '/flow/flows?lite=1', token);
  const list2 = await req('GET', '/flow/flows?lite=1', token);

  const flow = await WhatsAppFlow.findOne({
    clientId,
    flowId: { $exists: true, $nin: [null, ''] },
  })
    .select('flowId')
    .lean();
  let graph1 = { status: 0, ms: 0, cache: null };
  let graph2 = { status: 0, ms: 0, cache: null };
  if (flow?.flowId) {
    graph1 = await req('GET', `/flow/flows/${flow.flowId}/graph`, token);
    graph2 = await req('GET', `/flow/flows/${flow.flowId}/graph`, token);
  }

  const report = {
    clientId,
    list1Ms: list1.ms,
    list2Ms: list2.ms,
    list2CacheTarget: list2.ms < 500,
    list2Cache: list2.cache,
    flowCount: list1.data?.flows?.length ?? 0,
    graph1Ms: graph1.ms,
    graph2Ms: graph2.ms,
    graph2CacheTarget: graph2.ms < 1000,
    graph2Cache: graph2.cache,
    flowId: flow?.flowId || null,
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();

  const pass =
    list1.status === 200 &&
    list2.status === 200 &&
    list2.ms < 500 &&
    (!flow?.flowId || (graph1.status === 200 && graph2.ms < 1000));

  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
