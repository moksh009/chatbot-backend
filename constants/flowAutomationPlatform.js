/**
 * Flow Builder automations are WhatsApp-only in V1.
 * Ignore legacy client payloads (website, omnichannel, etc.).
 */
const FLOW_AUTOMATION_PLATFORM = 'whatsapp';

function normalizeFlowAutomationPlatform(_value) {
  return FLOW_AUTOMATION_PLATFORM;
}

module.exports = {
  FLOW_AUTOMATION_PLATFORM,
  normalizeFlowAutomationPlatform,
};
