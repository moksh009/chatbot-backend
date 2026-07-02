'use strict';

/**
 * COD → Prepaid journey node — template must have a URL button for checkout injection.
 * Accepts static URLs AND dynamic checkout URL slots ({{1}}, urlVariable, urlType Dynamic).
 */

function normalizeComponents(template) {
  return template?.components || template?.raw?.components || [];
}

function collectButtonRows(template) {
  const rows = [];
  const components = normalizeComponents(template);
  const buttonsComp = components.find((c) => String(c.type || '').toUpperCase() === 'BUTTONS');
  if (buttonsComp?.buttons?.length) rows.push(...buttonsComp.buttons);

  const formButtons = template?.formData?.buttons;
  if (Array.isArray(formButtons) && formButtons.length) rows.push(...formButtons);

  const topButtons = template?.buttons;
  if (Array.isArray(topButtons) && topButtons.length) rows.push(...topButtons);

  return rows;
}

function isUrlTypeButton(btn) {
  return String(btn?.type || btn?.buttonType || '').toUpperCase() === 'URL';
}

/** Any URL button — runtime injects draft invoice URL (static or dynamic slot). */
function templateHasCheckoutUrlButton(template) {
  return collectButtonRows(template).some(isUrlTypeButton);
}

/** Strict static URL only (no {{ }} placeholders). */
function templateHasStaticUrlButton(template) {
  return collectButtonRows(template).some((btn) => {
    if (!isUrlTypeButton(btn)) return false;
    if (btn.urlVariable) return false;
    if (String(btn.urlType || '').toLowerCase() === 'dynamic') return false;
    const url = String(btn.url || '').trim();
    return url && !/\{\{/.test(url);
  });
}

module.exports = {
  collectButtonRows,
  isUrlTypeButton,
  templateHasCheckoutUrlButton,
  templateHasStaticUrlButton,
};
