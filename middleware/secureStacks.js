'use strict';

const { protect } = require('./auth');
const { verifyTenantScope } = require('./verifyTenantScope');
const { requireRole, requireRoleCategory } = require('./requireRole');
const { requirePaidOrTrial } = require('./requirePaidOrTrial');
const { tenantRateLimit } = require('./tenantRateLimit');

const scope = (opts) => verifyTenantScope(opts);

const tenantRead = [protect, scope(), requireRoleCategory('read')];
const tenantMutate = [
  protect,
  tenantRateLimit(),
  requirePaidOrTrial(),
  scope(),
  requireRoleCategory('mutate_config'),
];
const inboxSend = [
  protect,
  tenantRateLimit(),
  requirePaidOrTrial(),
  scope({ lookupBy: 'conversation', param: 'id' }),
  requireRoleCategory('inbox_send'),
];
const teamManage = [protect, scope(), requireRoleCategory('team')];
const billingAccess = [protect, scope(), requireRoleCategory('billing')];

module.exports = {
  protect,
  scope,
  requireRole,
  requireRoleCategory,
  tenantRead,
  tenantMutate,
  inboxSend,
  teamManage,
  billingAccess,
};
