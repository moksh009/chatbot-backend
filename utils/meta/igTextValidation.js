// Unicode code-point counting — correct for emoji
function codePointLength(str) {
  return [...str].length;
}

function validateIgText(text, fieldName, maxCodePoints, isRequired = true) {
  if (!text) {
    if (isRequired) return { valid: false, error: `${fieldName} is required.` };
    return { valid: true };
  }
  const len = codePointLength(text);
  if (len > maxCodePoints) {
    return {
      valid: false,
      error: `${fieldName} exceeds the maximum ${maxCodePoints} characters (currently ${len}). Instagram counts emoji as multiple code points.`
    };
  }
  return { valid: true };
}

const IG_LIMITS = {
  BUTTON_TEMPLATE_TEXT: 640,
  BUTTON_LABEL: 20,
  PLAIN_TEXT_DM: 1000,
  COMMENT_REPLY: 2200
};

function validateAutomationMessages(automation) {
  const errors = [];
  const isStrict = automation.status === 'active';

  const openingValidation = validateIgText(automation.flow.openingDm, 'Opening DM', IG_LIMITS.BUTTON_TEMPLATE_TEXT, isStrict);
  if (!openingValidation.valid) errors.push(openingValidation.error);

  const buttonValidation = validateIgText(automation.flow.openingButton, 'Opening button label', IG_LIMITS.BUTTON_LABEL, isStrict);
  if (!buttonValidation.valid) errors.push(buttonValidation.error);

  if (automation.flow.flowType === 'standard_link') {
    const secondValidation = validateIgText(automation.flow.secondMessage, 'Second message', IG_LIMITS.BUTTON_TEMPLATE_TEXT, isStrict);
    if (!secondValidation.valid) errors.push(secondValidation.error);

    (automation.flow.linkButtons || []).forEach((btn, i) => {
      const btnValidation = validateIgText(btn.label, `Link button ${i + 1} label`, IG_LIMITS.BUTTON_LABEL, isStrict);
      if (!btnValidation.valid) errors.push(btnValidation.error);
    });
  }

  if (automation.flow.flowType === 'follow_gate') {
    const { followGate } = automation.flow || {};
    if (followGate) {
      const checks = [
        [followGate.successMessage, 'Success message', IG_LIMITS.BUTTON_TEMPLATE_TEXT],
        [followGate.failMessage, 'Fail message', IG_LIMITS.BUTTON_TEMPLATE_TEXT],
        [followGate.terminalMessage, 'Terminal message', IG_LIMITS.PLAIN_TEXT_DM],
        [followGate.gateButtonLabel, 'Gate button label', IG_LIMITS.BUTTON_LABEL],
        [followGate.failRetryButtonLabel, 'Retry button label', IG_LIMITS.BUTTON_LABEL]
      ];
      checks.forEach(([text, field, max]) => {
        if (text || isStrict) {
          const v = validateIgText(text, field, max, isStrict);
          if (!v.valid) errors.push(v.error);
        }
      });
    } else if (isStrict) {
      errors.push('Follow gate configuration is required.');
    }
  }

  (automation.trigger?.commentReplies || []).forEach((reply, i) => {
    const v = validateIgText(reply, `Comment reply ${i + 1}`, IG_LIMITS.COMMENT_REPLY, isStrict);
    if (!v.valid) errors.push(v.error);
  });

  return errors;
}

module.exports = { codePointLength, validateAutomationMessages, IG_LIMITS };
