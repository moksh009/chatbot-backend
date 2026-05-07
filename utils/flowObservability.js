const FlowAnalytics = require('../models/FlowAnalytics');
const { emitToClient } = require('./socket');
const log = require('./logger')('FlowObservability');

function normalizeFlowId(flowId) {
  if (!flowId) return 'default_legacy';
  if (typeof flowId === 'string') return flowId;
  if (typeof flowId === 'object') return String(flowId._id || flowId.id || 'default_legacy');
  return String(flowId);
}

async function logFlowEvent({
  clientId,
  flowId,
  nodeId,
  nodeType,
  phone,
  action,
  metadata = {}
}) {
  if (!clientId || !nodeId || !action) return null;

  const payload = {
    clientId: String(clientId),
    flowId: normalizeFlowId(flowId),
    nodeId: String(nodeId),
    nodeType: nodeType ? String(nodeType) : undefined,
    phone: phone ? String(phone) : undefined,
    action: String(action),
    duration: Number(metadata?.latencyMs || 0),
    metadata,
    timestamp: new Date()
  };

  try {
    const saved = await FlowAnalytics.create(payload);
    emitToClient(payload.clientId, 'flow:observability:event', {
      _id: saved._id,
      ...payload
    });
    return saved;
  } catch (err) {
    log.error('Failed to persist flow event', { error: err.message, payload });
    return null;
  }
}

module.exports = {
  logFlowEvent
};

