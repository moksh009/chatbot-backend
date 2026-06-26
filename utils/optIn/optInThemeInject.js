'use strict';

const MARKER = '<!-- TopEdge Opt-In Tools -->';

/**
 * Build the theme.liquid script snippet for storefront opt-in tools.
 * @param {string} backendUrl
 * @param {string} embedKey
 * @param {string} clientId
 */
function buildOptInScriptTag(backendUrl, embedKey, clientId) {
  const base = String(backendUrl || 'https://api.topedgeai.com').replace(/\/$/, '');
  return (
    `\n${MARKER}\n` +
    `<script src="${base}/public/topedge-opt-in.js" ` +
    `data-embed-key="${embedKey}" ` +
    `data-client-id="${clientId}" ` +
    `async></script>\n`
  );
}

/**
 * Returns true if theme.liquid already contains the opt-in embed for this client.
 */
function themeHasOptInScript(liquid, clientId) {
  if (!liquid || !clientId) return false;
  return liquid.includes(MARKER) && liquid.includes(`data-client-id="${clientId}"`);
}

/**
 * Idempotently inject opt-in script before </body> (or </head> fallback).
 */
function injectOptInScriptIntoLiquid(liquid, backendUrl, embedKey, clientId) {
  if (!liquid) throw new Error('Could not read theme.liquid');
  if (themeHasOptInScript(liquid, clientId)) {
    return { liquid, alreadyPresent: true };
  }

  const scriptTag = buildOptInScriptTag(backendUrl, embedKey, clientId);
  let next = liquid;
  if (next.includes('</body>')) {
    next = next.replace('</body>', `${scriptTag}</body>`);
  } else if (next.includes('</head>')) {
    next = next.replace('</head>', `${scriptTag}</head>`);
  } else {
    next += scriptTag;
  }
  return { liquid: next, alreadyPresent: false };
}

/**
 * Remove opt-in script block from theme.liquid.
 */
function removeOptInScriptFromLiquid(liquid, clientId) {
  if (!liquid) return { liquid, removed: false };
  if (!themeHasOptInScript(liquid, clientId)) {
    return { liquid, removed: false };
  }

  const escapedClient = clientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `\\n?${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n?<script[^>]*data-client-id="${escapedClient}"[^>]*>\\s*</script>\\s*`,
    'gi'
  );
  let next = liquid.replace(blockRe, '\n');
  next = next.replace(
    new RegExp(
      `<script[^>]*topedge-opt-in\\.js[^>]*data-client-id="${escapedClient}"[^>]*>\\s*</script>\\s*`,
      'gi'
    ),
    ''
  );
  return { liquid: next, removed: true };
}

module.exports = {
  MARKER,
  buildOptInScriptTag,
  themeHasOptInScript,
  injectOptInScriptIntoLiquid,
  removeOptInScriptFromLiquid,
};
