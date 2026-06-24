'use strict';

process.env.SKIP_AUDIT_PERSIST = 'true';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function testSocketAuthModule() {
  const {
    canJoinClientRoom,
    canJoinSuperAdminRoom,
    canJoinAgentRoom,
    attachSocketAuthMiddleware,
    joinClientRoomSafely,
    leaveStaleClientRooms,
    ADMIN_PSEUDO_CLIENT_ID,
  } = require('../../utils/core/socketAuth');

  const merchant = { _id: 'u1', role: 'CLIENT_ADMIN', clientId: 'tenant_a' };
  const sa = { _id: 'sa1', role: 'SUPER_ADMIN', clientId: 'admin_home' };

  assert.strictEqual(canJoinClientRoom(merchant, 'tenant_a', {}), true);
  assert.strictEqual(canJoinClientRoom(merchant, 'tenant_b', {}), false);
  assert.strictEqual(canJoinClientRoom(sa, 'tenant_b', { clientId: 'tenant_b' }), true);
  assert.strictEqual(canJoinClientRoom(sa, 'tenant_b', { clientId: 'tenant_a' }), true);
  assert.strictEqual(canJoinClientRoom(sa, ADMIN_PSEUDO_CLIENT_ID, {}), true);

  assert.strictEqual(canJoinSuperAdminRoom(merchant), false);
  assert.strictEqual(canJoinSuperAdminRoom(sa), true);

  assert.strictEqual(canJoinAgentRoom(merchant, 'u1'), true);
  assert.strictEqual(canJoinAgentRoom(merchant, 'other'), false);
  assert.strictEqual(canJoinAgentRoom(sa, 'any'), true);

  assert.strictEqual(typeof attachSocketAuthMiddleware, 'function');
  assert.strictEqual(typeof joinClientRoomSafely, 'function');
  assert.strictEqual(typeof leaveStaleClientRooms, 'function');

  const rooms = new Set(['sock1', 'client_tenant_a', 'client_tenant_b', `client_${ADMIN_PSEUDO_CLIENT_ID}`]);
  const saSocket = {
    id: 'sock1',
    rooms,
    data: { user: sa, handshakeAuth: { clientId: 'tenant_b' } },
    join(r) {
      rooms.add(r);
    },
    leave(r) {
      rooms.delete(r);
    },
  };
  assert.strictEqual(joinClientRoomSafely(saSocket, sa, 'tenant_b', { clientId: 'tenant_b' }), true);
  assert.ok(saSocket.rooms.has('client_tenant_b'));
  assert.ok(!saSocket.rooms.has('client_tenant_a'));
  assert.ok(saSocket.rooms.has(`client_${ADMIN_PSEUDO_CLIENT_ID}`));
}

function testSocketJsUsesJwtAuth() {
  const src = read('utils/core/socket.js');
  assert.ok(src.includes('attachSocketAuthMiddleware'));
  assert.ok(!src.includes('handshake.query.clientId'));
  assert.ok(!src.includes("query.role"));
}

function testInboxRoutesScoped() {
  const src = read('routes/inboxRoutes.js');
  assert.ok(src.includes('inboxConversationScope'));
  assert.ok(src.includes("router.get('/conversations/:id/messages', inboxConversationScope()"));
  assert.ok(src.includes("router.patch('/conversations/:id/read', inboxConversationScope()"));
  assert.ok(src.includes("router.post('/conversations/:id/send', inboxConversationScope()"));
}

function testInboxScopeMiddleware() {
  assert.ok(fs.existsSync(path.join(ROOT, 'middleware/inboxConversationScope.js')));
  const src = read('middleware/inboxConversationScope.js');
  assert.ok(src.includes('tenantClientId'));
  assert.ok(src.includes('IGConversation'));
  assert.ok(src.includes('Conversation'));
  assert.ok(src.includes('channel query or body param is required'));
}

function testAutoTenantScopeInboxChannelAware() {
  const { inferScopeOpts } = require('../../middleware/autoTenantScope');
  const igReq = {
    originalUrl: '/api/inbox/conversations/507f1f77bcf86cd799439011/messages?channel=instagram',
    query: { channel: 'instagram' },
    body: {},
  };
  const waReq = {
    originalUrl: '/api/inbox/conversations/507f1f77bcf86cd799439011/messages?channel=whatsapp',
    query: { channel: 'whatsapp' },
    body: {},
  };
  assert.deepStrictEqual(inferScopeOpts(igReq), { lookupBy: 'igConversation', param: 'id' });
  assert.deepStrictEqual(inferScopeOpts(waReq), { lookupBy: 'conversation', param: 'id' });
}

function testRoiRouteTenantGuard() {
  const src = read('routes/analytics.js');
  const roiBlock = src.slice(src.indexOf('/:clientId/roi'), src.indexOf('/:clientId/roi') + 400);
  assert.ok(roiBlock.includes('denyUnlessTenant'));
}

function testPurgeEmbeddingLocked() {
  const be = read('routes/aiWallet.js');
  assert.ok(be.includes("role !== 'SUPER_ADMIN'"));
  assert.ok(be.includes('/purge-embedding-noise'));

  const fe = fs.readFileSync(
    path.join(ROOT, '..', 'chatbot-dashboard-frontend-main', 'src', 'components', 'intelligence', 'AiSetupTab.jsx'),
    'utf8'
  );
  assert.ok(!fe.includes('purge-embedding-noise'), 'AiSetupTab must not call purge on load');
}

function testSocketContextUsesAuthToken() {
  const fe = fs.readFileSync(
    path.join(ROOT, '..', 'chatbot-dashboard-frontend-main', 'src', 'context', 'SocketContext.jsx'),
    'utf8'
  );
  assert.ok(fe.includes('auth'));
  assert.ok(fe.includes("localStorage.getItem('token')"));
  assert.ok(!fe.includes('query: { clientId'), 'must not pass clientId via query');
}

function testAutoTenantScopeInboxPattern() {
  const src = read('middleware/autoTenantScope.js');
  assert.ok(src.includes('/api\\/inbox\\/conversations'));
}

function testDashboardPartialMeta() {
  const src = read('controllers/dashboardController.js');
  assert.ok(src.includes('failedSections'));
  assert.ok(src.includes('partial: true'));
}

function testLeadsBulkDeleteTenantScoped() {
  const src = read('routes/leads.js');
  const block = src.slice(src.indexOf("router.post('/bulk-delete'"), src.indexOf("router.post('/bulk-delete'") + 200);
  assert.ok(block.includes('tenantClientId(req)'));
}

function testWarrantyTenantScoped() {
  const src = read('routes/warranty.js');
  assert.ok(src.includes('tenantClientId'));
  assert.ok(!src.includes('req.user.clientId'));
}

function testWhatsappFlowsTenantScoped() {
  const src = read('routes/whatsappFlows.js');
  assert.ok(src.includes('tenantClientId(req)'));
  assert.ok(!src.includes('req.user.clientId'));
}

function testIntentsUseProtect() {
  const src = read('routes/intents.js');
  assert.ok(src.includes("protect"));
  assert.ok(!src.includes('verifyDashboardToken'));
}

function testCampaignsHotLeadsResolver() {
  const src = read('routes/campaigns.js');
  assert.ok(src.includes('resolveHotLeadsAudience'));
  assert.ok(src.includes('parseCsvColumnMapping'));
}

function testFlowPublishDemotesOthers() {
  const src = read('services/flowPublishService.js');
  assert.ok(src.includes("status: 'ARCHIVED'"));
}

function testTenantClientIdImpersonationHeader() {
  const { tenantClientId } = require('../../utils/core/queryHelpers');
  const req = {
    user: { role: 'SUPER_ADMIN', clientId: 'admin_home' },
    headers: { 'x-admin-impersonating': 'tenant_b' },
    params: {},
    query: {},
    body: {},
  };
  assert.strictEqual(tenantClientId(req), 'tenant_b');
}

function testAdminTeamImpersonationHeader() {
  const { tenantClientId } = require('../../utils/core/queryHelpers');
  const req = {
    user: {
      role: 'ADMIN_TEAM',
      isAdminTeam: true,
      permissions: { canImpersonateMerchants: true },
      allowedClientIds: ['tenant_b'],
    },
    headers: { 'x-admin-impersonating': 'tenant_b' },
    params: {},
    query: {},
    body: {},
  };
  assert.strictEqual(tenantClientId(req), 'tenant_b');
}

function testAdminTeamImpersonationBlockedOutsideAllowList() {
  const { tenantClientId } = require('../../utils/core/queryHelpers');
  const req = {
    user: {
      role: 'ADMIN_TEAM',
      isAdminTeam: true,
      permissions: { canImpersonateMerchants: true },
      allowedClientIds: ['tenant_a'],
    },
    headers: { 'x-admin-impersonating': 'tenant_b' },
    params: {},
    query: {},
    body: {},
  };
  assert.strictEqual(tenantClientId(req), null);
}

function testTemplateOpsAdminTeamAccess() {
  const { assertTemplateOpsAdmin } = require('../../services/templateAdminOps');
  assertTemplateOpsAdmin({
    role: 'ADMIN_TEAM',
    isAdminTeam: true,
    permissions: { manageTemplates: true },
  });
  let threw = false;
  try {
    assertTemplateOpsAdmin({
      role: 'ADMIN_TEAM',
      isAdminTeam: true,
      permissions: { viewClients: true },
    });
  } catch (e) {
    threw = e.status === 403;
  }
  assert.ok(threw, 'viewer without template perms should be denied');
}

function testBillingInvoicesTenantScoped() {
  const src = read('routes/billing.js');
  const block = src.slice(src.indexOf("router.get('/:clientId/invoices'"), src.indexOf("router.get('/:clientId/invoices'") + 120);
  assert.ok(block.includes('verifyTenantScope'));
}

function testSupportModuleLoads() {
  const src = read('routes/support.js');
  assert.ok(src.includes('buildDocsContextForPrompt'));
  require('../../routes/support');
}

function testAdminWebhookUsesTenantClientId() {
  const src = read('routes/admin.js');
  const idx = src.indexOf('/whatsapp-webhook-instructions');
  const block = src.slice(idx, idx + 1200);
  assert.ok(block.includes('tenantClientId(req)'));
}

function testWinningProductsTenantScoped() {
  const src = read('routes/winningProducts.js');
  assert.ok(src.includes("router.get('/workspace', protect"));
  assert.ok(src.includes('assertTenant(req, res, clientId)'));
  assert.ok(src.includes('MetaAudienceQueue.find({ clientId'));
  assert.ok(src.includes('invalidateWinningProductsCache'));
  assert.ok(!src.includes('req.user.clientId') || src.includes("req.user?.clientId !== clientId"));
}

async function main() {
  testSocketAuthModule();
  testSocketJsUsesJwtAuth();
  testInboxRoutesScoped();
  testInboxScopeMiddleware();
  testRoiRouteTenantGuard();
  testPurgeEmbeddingLocked();
  testSocketContextUsesAuthToken();
  testAutoTenantScopeInboxPattern();
  testAutoTenantScopeInboxChannelAware();
  testDashboardPartialMeta();
  testLeadsBulkDeleteTenantScoped();
  testWarrantyTenantScoped();
  testWhatsappFlowsTenantScoped();
  testIntentsUseProtect();
  testCampaignsHotLeadsResolver();
  testFlowPublishDemotesOthers();
  testTenantClientIdImpersonationHeader();
  testAdminTeamImpersonationHeader();
  testAdminTeamImpersonationBlockedOutsideAllowList();
  testTemplateOpsAdminTeamAccess();
  testBillingInvoicesTenantScoped();
  testSupportModuleLoads();
  testAdminWebhookUsesTenantClientId();
  testWinningProductsTenantScoped();
  console.log('? sprint0Security tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
