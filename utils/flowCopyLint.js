const { normalizeNodeType } = require('./flowNodeContract');

function countEmojis(str) {
  if (!str) return 0;
  // Rough heuristic: count surrogate pairs / emoji ranges; good enough for warning lint.
  const s = String(str);
  const emojiLike = s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu);
  return emojiLike ? emojiLike.length : 0;
}

function lintCopyInFlow({ nodes = [] }) {
  const warnings = [];
  const safeNodes = Array.isArray(nodes) ? nodes : [];

  for (const node of safeNodes) {
    const type = normalizeNodeType(node?.type);
    const texts = [];

    if (type === 'message') texts.push(node.data?.text, node.data?.body);
    if (type === 'interactive') texts.push(node.data?.text, node.data?.body);
    if (type === 'capture_input') texts.push(node.data?.question, node.data?.text);
    if (type === 'template') texts.push(node.data?.previewText);

    const joined = texts.filter(Boolean).join('\n');
    if (!joined) continue;

    const emojiCount = countEmojis(joined);
    if (emojiCount >= 8) {
      warnings.push({
        code: 'COPY_TOO_MANY_EMOJIS',
        nodeId: node.id,
        message: `High emoji density detected (${emojiCount}). Consider reducing for enterprise tone and clarity.`,
        fix: 'Reduce emojis to emphasize key CTAs and improve readability.',
      });
    }

    if (/FREE\s*!!!|100%\s*GUARANTEED|GUARANTEED\s*DELIVERY/i.test(joined)) {
      warnings.push({
        code: 'COPY_RISKY_CLAIMS',
        nodeId: node.id,
        message: 'Potentially risky claims detected (guarantees/excessive hype). Consider compliance-safe wording.',
        fix: 'Remove guarantees and use verifiable statements only.',
      });
    }

    if (/(expires in \d+|only \d+ left|last chance in \d+)/i.test(joined)) {
      warnings.push({
        code: 'COPY_SCARCITY_UNVERIFIED',
        nodeId: node.id,
        message: 'Scarcity/urgency language detected. Ensure it is truthful and supported by real inventory/timing.',
        fix: 'Replace with truthful urgency (e.g., “inventory moves fast”) unless you have real-time proof.',
      });
    }
  }

  return { warnings };
}

module.exports = { lintCopyInFlow };

