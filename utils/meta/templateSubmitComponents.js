const { sanitizeMetaTemplateBodyForSubmission } = require('./metaTemplateCompliance');

/**
 * Build Meta Graph `components` array from MetaTemplate doc or local messageTemplates row.
 */
function buildComponentsForMetaSubmit(template) {
  if (!template) return [];

  if (Array.isArray(template.components) && template.components.length > 0) {
    return template.components.map((c) => {
      const comp = { ...c };
      delete comp._imageUrl;
      return comp;
    });
  }

  const components = [];
  const ht = String(template.headerType || 'TEXT').toUpperCase();
  if (ht === 'IMAGE' && template.headerValue) {
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_url: [template.headerValue] },
    });
  } else if (ht === 'TEXT' && template.headerValue) {
    components.push({ type: 'HEADER', format: 'TEXT', text: template.headerValue });
  }

  const bodyText = sanitizeMetaTemplateBodyForSubmission(template.body || template.formData?.bodyText || '');
  if (!bodyText) return [];

  const bodyComponent = { type: 'BODY', text: bodyText };
  let vm = template.variableMapping;
  if (vm && !(vm instanceof Map)) {
    vm = new Map(Object.entries(vm));
  }
  if (vm instanceof Map && vm.size > 0) {
    const ordered = Array.from(vm.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, v]) => String(v));
    bodyComponent.example = { body_text: [ordered] };
  }
  components.push(bodyComponent);

  if (template.footerText) {
    components.push({ type: 'FOOTER', text: template.footerText });
  }

  if (Array.isArray(template.buttons) && template.buttons.length > 0) {
    const buttonComponents = template.buttons
      .map((btn) => {
        const type = String(btn.type || btn.buttonType || '').toUpperCase();
        if (type === 'URL') return { type: 'url', text: btn.text, url: btn.url };
        if (type === 'QUICK_REPLY') return { type: 'quick_reply', text: btn.text };
        return null;
      })
      .filter(Boolean);
    if (buttonComponents.length > 0) {
      components.push({ type: 'BUTTONS', buttons: buttonComponents });
    }
  }

  return components;
}

module.exports = { buildComponentsForMetaSubmit };
