'use strict';

const { PLAN_LIMITS } = require('../../config/planCatalog');

/** Billing limits removed (2026-06) — always allow unless workspace missing. */
async function checkLimit(identifier) {
  const Client = require('../../models/Client');
  const mongoose = require('mongoose');

  let query = { clientId: identifier };
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    query = { $or: [{ _id: identifier }, { clientId: identifier }] };
  }

  const client = await Client.findOne(query).lean();
  if (!client) {
    return { allowed: false, reason: 'Workspace not found', code: 'NO_CLIENT' };
  }

  return { allowed: true, limit: Infinity, usage: 0 };
}

async function incrementUsage() {
  /* no-op — usage metering disabled until commercial rebuild */
}

function effectivePlanKey() {
  return 'unlimited';
}

module.exports = { checkLimit, incrementUsage, PLAN_LIMITS, effectivePlanKey };
