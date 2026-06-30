'use strict';

/**
 * Flow Builder template helpers (backend mirror of frontend flowTemplateMapping.js).
 */
function getTemplateQuickReplyButtons(template) {
  const comp = (template?.components || []).find((c) => String(c.type || '').toUpperCase() === 'BUTTONS');
  if (!comp?.buttons?.length) return [];
  return comp.buttons.filter((btn) => {
    const t = String(btn.type || 'QUICK_REPLY').toUpperCase();
    return t === 'QUICK_REPLY';
  });
}

function templateNodeHasQuickReplies(client, nodeData = {}) {
  const name = nodeData.templateName || nodeData.metaTemplateName;
  if (!name) return false;
  const tpl = (client?.syncedMetaTemplates || []).find((t) => t.name === name);
  return getTemplateQuickReplyButtons(tpl).length > 0;
}

function deriveTemplateSourceHandle(template, userInput = '') {
  const raw = String(userInput || '').trim();
  if (!raw) return '';
  if (raw.startsWith('tpl_btn_')) return raw;

  const textLower = raw.toLowerCase();
  const buttons = getTemplateQuickReplyButtons(template);

  const legacy = raw.match(/^btn_(\d+)$/);
  if (legacy) {
    const idx = Number(legacy[1]);
    if (idx >= 0 && idx < buttons.length) return `tpl_btn_${idx}`;
  }

  const idx = buttons.findIndex((b) => String(b.text || '').toLowerCase() === textLower);
  if (idx >= 0) return `tpl_btn_${idx}`;
  return textLower.replace(/\s+/g, '_');
}

module.exports = {
  getTemplateQuickReplyButtons,
  templateNodeHasQuickReplies,
  deriveTemplateSourceHandle,
};
