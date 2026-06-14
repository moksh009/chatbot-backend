'use strict';

/**
 * Single source of truth for optional API modules mounted in index.js.
 * Frontend probes GET /api/capabilities before calling optional routes —
 * avoids 404 storms when local API is stale or split deploy omits modules.
 */
const CAPABILITIES_VERSION = 1;

const MODULES = Object.freeze({
  emailHub: {
    mount: '/api/email-hub',
    description: 'Email templates, analytics, consent events, Gmail OAuth',
  },
  logistics: {
    mount: '/api/workspace/:clientId/logistics',
    aliasMount: '/api/client/:clientId/logistics',
    description: 'Logistics partner profile, NDR settings, Shiprocket credentials',
  },
  logisticsInbound: {
    mount: '/api/logistics',
    description: 'Courier webhook ingress (Shiprocket, etc.)',
  },
});

function getApiCapabilities() {
  return {
    version: CAPABILITIES_VERSION,
    modules: Object.keys(MODULES).reduce((acc, key) => {
      acc[key] = true;
      return acc;
    }, {}),
    mounts: MODULES,
  };
}

module.exports = {
  CAPABILITIES_VERSION,
  MODULES,
  getApiCapabilities,
};
