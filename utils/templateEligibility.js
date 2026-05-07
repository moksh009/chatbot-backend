const PURPOSES = ['campaign', 'sequence', 'flow', 'ig', 'utility'];

function normalizePurpose(input, fallback = 'utility') {
  const value = String(input || fallback).trim().toLowerCase();
  return PURPOSES.includes(value) ? value : fallback;
}

function normalizeStatus(input) {
  const value = String(input || '').toUpperCase();
  if (value === 'APPROVED') return 'APPROVED';
  if (value === 'REJECTED') return 'REJECTED';
  if (value === 'PENDING' || value === 'QUEUED' || value === 'SUBMITTING') return 'PENDING';
  return value || 'DRAFT';
}

function getBodyVariableCount(template) {
  const body = (template?.components || []).find((c) => String(c?.type || '').toUpperCase() === 'BODY');
  if (!body?.text) return 0;
  const matches = body.text.match(/\{\{\d+\}\}/g) || [];
  const numeric = matches
    .map((m) => Number(m.replace(/[{}]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  return numeric.length ? Math.max(...numeric) : 0;
}

function hasImageHeader(template) {
  return (template?.components || []).some(
    (c) => String(c?.type || '').toUpperCase() === 'HEADER' && String(c?.format || '').toUpperCase() === 'IMAGE'
  );
}

function validateTemplateEligibility({
  template,
  contextPurpose = 'utility',
  availableFields = [],
  providedVariables = [],
  strict = true,
}) {
  const reasons = [];
  const warnings = [];
  const normalizedPurpose = normalizePurpose(contextPurpose);
  const normalizedStatus = normalizeStatus(template?.status || template?.submissionStatus);
  const primaryPurpose = normalizePurpose(template?.primaryPurpose || 'utility');
  const secondaryPurposes = Array.isArray(template?.secondaryPurposes)
    ? template.secondaryPurposes.map((p) => normalizePurpose(p))
    : [];
  const allowedPurposes = new Set([primaryPurpose, ...secondaryPurposes]);

  if (!template?.name) {
    return { ok: false, reasons: ['Template not found'], warnings, missingVariables: [], requiredVariableCount: 0 };
  }
  if (normalizedStatus !== 'APPROVED') {
    reasons.push(`Template "${template.name}" is ${normalizedStatus}, not APPROVED.`);
  }

  if (!allowedPurposes.has(normalizedPurpose) && normalizedPurpose !== 'utility') {
    reasons.push(`Template "${template.name}" is not tagged for ${normalizedPurpose} use.`);
  }

  const requiredVariableCount = getBodyVariableCount(template);
  const providedCount = Array.isArray(providedVariables) ? providedVariables.length : 0;
  const fieldSet = new Set((availableFields || []).map((f) => String(f || '').trim()).filter(Boolean));

  const missingVariables = [];
  for (let i = 1; i <= requiredVariableCount; i += 1) {
    const provided = Array.isArray(providedVariables) ? providedVariables[i - 1] : null;
    if (provided !== undefined && provided !== null && String(provided).trim() !== '') continue;
    const mappedField = String(i);
    if (!fieldSet.has(mappedField)) {
      missingVariables.push(`{{${i}}}`);
    }
  }

  if (missingVariables.length) {
    reasons.push(
      `Template "${template.name}" requires ${requiredVariableCount} variable(s), missing: ${missingVariables.join(', ')}.`
    );
  }

  if (hasImageHeader(template)) {
    warnings.push('Template uses an image header. Make sure a valid media URL/handle is supplied.');
  }

  const ok = strict ? reasons.length === 0 : normalizedStatus === 'APPROVED';
  return { ok, reasons, warnings, missingVariables, requiredVariableCount };
}

module.exports = {
  PURPOSES,
  normalizePurpose,
  validateTemplateEligibility,
  getBodyVariableCount,
};
