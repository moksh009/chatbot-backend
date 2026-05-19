/**
 * Phase 4A HTTP sign-off — conversations cache hit, full-context, POST /messages (no exec error).
 * Usage: node scripts/signoff4AHttp.js [--clientId=delitech_smarthomes] [--skipSend]
 */
const { loadSignoffEnv, requireFromRoot } = require('../../_lib/signoffEnv');
loadSignoffEnv();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = process.env.SIGNOFF_API_BASE || 'http://localhost:5001/api';
const skipSend = process.argv.includes('--skipSend');

async function req(method, urlPath, token, body) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const t0 = Date.now();
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload });
  const ms = Date.now() - t0;
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text?.slice(0, 500) };
  }
  return { status: res.status, ms, data };
}

async function run() {
  const clientId =
    process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = requireFromRoot('models/User');
  const Conversation = requireFromRoot('models/Conversation');

  const user = await User.findOne({ clientId }).select('_id role clientId').lean();
  if (!user) throw new Error(`No user for clientId=${clientId}`);

  const token = jwt.sign(
    { id: user._id, clientId: user.clientId, role: user.role || 'CLIENT_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const conv = await Conversation.findOne({ clientId })
    .sort({ lastMessageAt: -1 })
    .select('_id phone')
    .lean();
  if (!conv) throw new Error('No conversation found for sign-off');

  const list1 = await req('GET', `/conversations?clientId=${clientId}&limit=50`, token);
  const list2 = await req('GET', `/conversations?clientId=${clientId}&limit=50`, token);
  const ctx = await req('GET', `/conversations/${conv._id}/full-context`, token);

  let send = { skipped: true };
  if (!skipSend) {
    send = await req('POST', `/conversations/${conv._id}/messages`, token, {
      content: `[4A-signoff ${new Date().toISOString()}] perf check — ignore`,
    });
  }

  const execError =
    send.data?.message?.includes?.('exec is not a function') ||
    send.data?.error?.includes?.('exec is not a function');

  const report = {
    clientId,
    conversationId: String(conv._id),
    list1Ms: list1.ms,
    list1Status: list1.status,
    list2Ms: list2.ms,
    list2Status: list2.status,
    list2CacheHitTarget: list2.ms < 500,
    fullContextMs: ctx.ms,
    fullContextStatus: ctx.status,
    fullContextTarget: ctx.ms < 500,
    sendMs: send.ms,
    sendStatus: send.status,
    sendExecError: !!execError,
    sendMessage: send.data?.message || send.data?.error || null,
  };

  console.log(JSON.stringify(report, null, 2));

  await mongoose.disconnect();

  const pass =
    list1.status === 200 &&
    list2.status === 200 &&
    list2.ms < 500 &&
    ctx.status === 200 &&
    !execError &&
    (skipSend || (send.status >= 200 && send.status < 300));

  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
