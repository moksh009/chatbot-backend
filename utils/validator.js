/**
 * utils/validator.js
 * TopEdge AI — Phase 19: Proactive Error Prevention Engine
 *
 * All validation functions return { valid, errors, warnings }
 * Errors = hard stops (send will fail). Warnings = soft issues (send may partially succeed).
 */

// ── TEMPLATE VALIDATOR ──────────────────────────────────────────────────────

/**
 * Validates a Meta WhatsApp template before sending.
 */
async function validateTemplateForSend(client, templateName, variables = [], phone = null) {
  const errors   = [];
  const warnings = [];

  // 1. WhatsApp token must be set
  if (!client.whatsappToken) {
    errors.push({
      code:    'NO_WHATSAPP_TOKEN',
      message: 'WhatsApp API token is not configured.',
      fix:     'Go to Settings → Channels → Paste your WhatsApp Permanent Token.'
    });
  }

  // 2. Phone Number ID must be set
  if (!client.phoneNumberId) {
    errors.push({
      code:    'NO_PHONE_NUMBER_ID',
      message: 'WhatsApp Phone Number ID is not configured.',
      fix:     'Go to Settings → Channels → Enter your Phone Number ID from Meta Developer Console.'
    });
  }

  // 3. Template must exist in syncedMetaTemplates
  const template = (client.syncedMetaTemplates || []).find(t => t.name === templateName);
  if (!template) {
    errors.push({
      code:    'TEMPLATE_NOT_FOUND',
      message: `Template "${templateName}" not found in your synced templates.`,
      fix:     'Go to Template Studio → Sync from Meta to refresh your approved templates.'
    });
    return { valid: false, errors, warnings };
  }

  // 4. Template must be APPROVED
  if (template.status !== 'APPROVED') {
    errors.push({
      code:    'TEMPLATE_NOT_APPROVED',
      message: `Template "${templateName}" is ${template.status}, not APPROVED.`,
      fix:     template.status === 'PENDING'
        ? 'Meta is still reviewing this template. Wait for approval (usually 10–15 minutes).'
        : 'This template was rejected by Meta. Create a new template following Meta guidelines.'
    });
  }

  // 5. Variable count check
  const bodyComponent = (template.components || []).find(c => c.type === 'BODY');
  if (bodyComponent) {
    const templateVarCount = (bodyComponent.text?.match(/\{\{\d+\}\}/g) || []).length;
    const providedVarCount = variables.length;

    if (providedVarCount < templateVarCount) {
      errors.push({
        code:     'VARIABLE_COUNT_MISMATCH',
        message:  `Template needs ${templateVarCount} variables but only ${providedVarCount} were provided.`,
        fix:      `Add ${templateVarCount - providedVarCount} more variable mapping(s) in the template configuration.`,
        required: templateVarCount,
        provided: providedVarCount
      });
    }

    // 6. No variable should be empty
    variables.forEach((v, i) => {
      if (!v || String(v).trim() === '') {
        errors.push({
          code:    'EMPTY_VARIABLE',
          message: `Variable {{${i + 1}}} is empty. Meta rejects templates with blank parameters.`,
          fix:     `Provide a fallback value for variable {{${i + 1}}} or use "N/A" as default.`
        });
      }
    });
  }

  // 7. Warning if header image component but no URL provided
  const headerComponent = (template.components || []).find(c => c.type === 'HEADER' && c.format === 'IMAGE');
  if (headerComponent && !variables.headerImageUrl) {
    warnings.push({
      code:    'MISSING_HEADER_IMAGE',
      message: 'This template has an image header but no image URL was provided.',
      fix:     'The template will send without a header image. Add an image URL to improve engagement.'
    });
  }

  return {
    valid:    errors.length === 0,
    errors,
    warnings,
    template
  };
}

// ── EMAIL VALIDATOR ──────────────────────────────────────────────────────────

async function validateEmailConfig(client, recipientEmail, subject, body) {
  const errors   = [];
  const warnings = [];

  // 1. SMTP must be configured
  const smtp = client.smtpConfig || client.emailConfig || {};
  const hasSmtp = smtp.host || client.emailUser;
  if (!hasSmtp && !client.sendgridApiKey) {
    errors.push({
      code:    'NO_EMAIL_CONFIG',
      message: 'Email (SMTP) is not configured.',
      fix:     'Go to Settings → Channels → Configure SMTP with your Gmail App Password or SMTP provider.'
    });
  }

  // 2. Validate email address format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (recipientEmail && !emailRegex.test(recipientEmail)) {
    errors.push({
      code:    'INVALID_EMAIL',
      message: `"${recipientEmail}" is not a valid email address.`,
      fix:     'Enter a valid email address in format: name@domain.com'
    });
  }

  // 3. Subject cannot be empty
  if (!subject || subject.trim() === '') {
    errors.push({
      code:    'EMPTY_SUBJECT',
      message: 'Email subject cannot be empty.',
      fix:     'Enter a subject line for the email.'
    });
  }

  // 4. Body cannot be empty
  if (!body || body.trim() === '') {
    errors.push({
      code:    'EMPTY_BODY',
      message: 'Email body cannot be empty.',
      fix:     'Write the email content.'
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── CAMPAIGN VALIDATOR ───────────────────────────────────────────────────────

async function validateCampaign(client, campaignData) {
  const errors   = [];
  const warnings = [];

  const { templateName, audience, variables = [], scheduledAt } = campaignData;
  const isLargeCampaign = audience?.count >= 1000;

  // 1. Must have a template
  if (!templateName) {
    errors.push({
      code:    'NO_TEMPLATE_SELECTED',
      message: 'No template selected for this campaign.',
      fix:     'Select an approved WhatsApp template for this campaign.'
    });
  } else {
    const templateValidation = await validateTemplateForSend(client, templateName, variables);
    
    // Optimization Shield: Upgrade warnings to errors for 1,000+ blasts
    if (isLargeCampaign) {
      templateValidation.warnings.forEach(w => {
        if (w.code === 'MISSING_HEADER_IMAGE') {
          errors.push({
            ...w,
            code: 'SHIELD_IMAGE_PROTECT',
            message: `Optimization Shield: Sending to 1,000+ leads without an image header will result in low engagement.`,
            fix: 'Add a header image URL or switch to a text-only template to protect your ROI.'
          });
        }
      });
      // Filter out the warnings that became errors
      templateValidation.warnings = templateValidation.warnings.filter(w => w.code !== 'MISSING_HEADER_IMAGE');
    }

    errors.push(...templateValidation.errors);
    warnings.push(...templateValidation.warnings);
  }

  // 2. Must have audience
  if (!audience || audience.count === 0) {
    errors.push({
      code:    'EMPTY_AUDIENCE',
      message: 'No recipients in the selected audience.',
      fix:     'Select a CSV, segment, or lead list with at least 1 recipient.'
    });
  }

  // 3. Missing phones warning
  if (audience?.missingPhones > 0) {
    warnings.push({
      code:    'MISSING_PHONES',
      message: `${audience.missingPhones} leads have no phone number and will be skipped.`,
      fix:     'Export and clean your lead list before uploading.'
    });
  }

  // 4. Scheduled time cannot be in the past
  if (scheduledAt && new Date(scheduledAt) < new Date()) {
    errors.push({
      code:    'SCHEDULE_IN_PAST',
      message: 'Scheduled time is in the past.',
      fix:     'Choose a future date and time for the campaign.'
    });
  }

  // 5. Optimization Shield: Large audience warning
  if (isLargeCampaign) {
    warnings.push({
      code:    'SHIELD_THROTTLING_ACTIVE',
      message: `Optimization Shield: Sending to ${audience.count} recipients. System will automatically throttle delivery across 24 hours to prevent Meta SPAM flags.`,
      fix:     'No action needed. Our AI is managing the bitrate for maximum delivery.'
    });
  }

  return {
    valid:          errors.length === 0,
    errors,
    warnings,
    recipientCount: audience?.count || 0,
    shieldActive: isLargeCampaign
  };
}

// ── FLOW NODE VALIDATOR ──────────────────────────────────────────────────────

function validateFlowNode(node, client) {
  const errors   = [];
  const warnings = [];

  switch (node.type) {
    case 'TemplateNode': {
      const { templateName } = node.data || {};
      if (!templateName) {
        errors.push({
          code:    'NODE_NO_TEMPLATE',
          nodeId:  node.id,
          message: 'Template node has no template selected.',
          fix:     'Click the node and select an approved Meta template.'
        });
      } else {
        const template = (client.syncedMetaTemplates || []).find(t => t.name === templateName);
        if (!template) {
          errors.push({
            code:    'NODE_TEMPLATE_NOT_FOUND',
            nodeId:  node.id,
            message: `Template "${templateName}" not found. It may have been deleted from Meta.`,
            fix:     'Sync templates from Meta in Template Studio, then re-select.'
          });
        } else if (template.status !== 'APPROVED') {
          errors.push({
            code:    'NODE_TEMPLATE_NOT_APPROVED',
            nodeId:  node.id,
            message: `Template "${templateName}" is ${template.status}, not APPROVED.`,
            fix:     'Wait for Meta approval or select a different template.'
          });
        }
      }
      break;
    }

    case 'MessageNode': {
      if (!node.data?.text && !node.data?.imageUrl) {
        errors.push({
          code:    'NODE_EMPTY_MESSAGE',
          nodeId:  node.id,
          message: 'Message node has no content.',
          fix:     'Add text or an image URL to this message node.'
        });
      }
      break;
    }

    case 'InteractiveNode': {
      const buttons = node.data?.buttonsList || node.data?.buttons || [];
      if (buttons.length === 0) {
        errors.push({
          code:    'NODE_NO_BUTTONS',
          nodeId:  node.id,
          message: 'Interactive node has no buttons.',
          fix:     'Add at least 1 button to this interactive node.'
        });
      }
      if (buttons.length > 3) {
        errors.push({
          code:    'NODE_TOO_MANY_BUTTONS',
          nodeId:  node.id,
          message: `Interactive node has ${buttons.length} buttons. WhatsApp allows max 3.`,
          fix:     'Remove buttons until you have 3 or fewer. Use a List node for more options.'
        });
      }
      buttons.forEach((btn, i) => {
        if ((btn.title || btn.label || '').length > 20) {
          warnings.push({
            code:    'BUTTON_TEXT_TOO_LONG',
            nodeId:  node.id,
            message: `Button ${i + 1} text is over 20 characters. Meta may truncate it.`,
            fix:     'Shorten the button label to 20 characters or less.'
          });
        }
      });
      break;
    }

    case 'CaptureNode': {
      if (!node.data?.variable) {
        errors.push({
          code:    'NODE_NO_VARIABLE',
          nodeId:  node.id,
          message: 'Capture node has no variable name.',
          fix:     "Set a variable name (e.g. 'customer_email') to store the captured input."
        });
      }
      if (!node.data?.text) {
        errors.push({
          code:    'NODE_NO_QUESTION',
          nodeId:  node.id,
          message: 'Capture node has no question to ask.',
          fix:     'Add the question text that will be sent to the customer.'
        });
      }
      break;
    }

    case 'WebhookNode': {
      if (!node.data?.url) {
        errors.push({
          code:    'NODE_NO_URL',
          nodeId:  node.id,
          message: 'Webhook node has no URL.',
          fix:     'Add the external URL to call.'
        });
      }
      if (node.data?.url && !node.data.url.startsWith('https://')) {
        warnings.push({
          code:    'NODE_HTTP_URL',
          nodeId:  node.id,
          message: 'Webhook URL uses HTTP instead of HTTPS.',
          fix:     'Use HTTPS for security. Many servers reject HTTP requests.'
        });
      }
      break;
    }

    default:
      break;
  }

  return { errors, warnings };
}

// ── AUTOMATION FLOW VALIDATOR ────────────────────────────────────────────────

async function validateAutomationFlow(client, flowType) {
  const errors   = [];
  const warnings = [];

  const flow = (client.automationFlows || []).find(f => f.id === flowType);
  if (!flow) {
    return {
      valid:    true,
      errors:   [],
      warnings: [{ code: 'FLOW_NOT_CONFIGURED', message: `Automation "${flowType}" is not configured.` }]
    };
  }

  if (!flow.isActive) {
    return {
      valid:    true,
      errors:   [],
      warnings: [{ code: 'FLOW_DISABLED', message: `"${flowType}" automation is currently disabled.` }]
    };
  }

  switch (flowType) {
    case 'abandoned_cart': {
      if (!client.shopDomain && client.storeType !== 'woocommerce') {
        errors.push({
          code:    'NO_STORE',
          message: 'Abandoned cart recovery requires a connected store.',
          fix:     'Go to Settings → Store → Connect your Shopify or WooCommerce store.'
        });
      }
      const template1 = flow.config?.template1;
      if (template1) {
        const t = (client.syncedMetaTemplates || []).find(t => t.name === template1);
        if (!t || t.status !== 'APPROVED') {
          errors.push({
            code:    'RECOVERY_TEMPLATE_NOT_APPROVED',
            message: `Recovery template "${template1}" is not approved.`,
            fix:     'Sync templates from Meta or select an approved template in Settings → Automations.'
          });
        }
      } else {
        warnings.push({
          code:    'NO_RECOVERY_TEMPLATE',
          message: 'No template assigned for Abandoned Cart Message 1.',
          fix:     'Assign an approved template in Settings → Automations → Cart Recovery.'
        });
      }
      break;
    }

    case 'cod_to_prepaid': {
      if (!client.razorpayKeyId || !client.razorpaySecret) {
        errors.push({
          code:    'NO_PAYMENT_GATEWAY',
          message: 'COD to Prepaid conversion requires Razorpay credentials.',
          fix:     'Go to Settings → Financials → Enter your Razorpay Key ID and Secret.'
        });
      }
      break;
    }

    case 'review_collection': {
      if (!client.googleReviewUrl) {
        warnings.push({
          code:    'NO_REVIEW_URL',
          message: 'No Google Review URL configured.',
          fix:     'Go to Settings → Neural Repo → Add your Google Review URL.'
        });
      }
      break;
    }

    case 'birthday': {
      // Birthday messages just need a template
      const bTemplate = flow.config?.templateName;
      if (!bTemplate) {
        warnings.push({
          code:    'NO_BIRTHDAY_TEMPLATE',
          message: 'No template assigned for birthday messages.',
          fix:     'Assign an approved template in Settings → Automations → Birthday Messages.'
        });
      }
      break;
    }

    default:
      break;
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── SYSTEM HEALTH CHECK ──────────────────────────────────────────────────────

async function getSystemHealth(client) {
  const checks = [];

  // WhatsApp
  checks.push({
    name:    'WhatsApp Connection',
    status:  client.whatsappToken && client.phoneNumberId ? 'ok' : 'error',
    message: !client.whatsappToken    ? 'No WhatsApp token configured'
           : !client.phoneNumberId   ? 'No Phone Number ID configured'
           : 'Connected',
    fix:     'Settings → Channels → WhatsApp'
  });

  // Store
  checks.push({
    name:    'Store Connection',
    status:  client.shopDomain || client.woocommerceUrl ? 'ok' : 'warning',
    message: client.shopDomain     ? `Shopify: ${client.shopDomain}`
           : client.woocommerceUrl ? `WooCommerce: ${client.woocommerceUrl}`
           : 'No store connected',
    fix:     'Settings → Store'
  });

  // AI
  checks.push({
    name:    'AI Engine',
    status:  client.systemPrompt ? 'ok' : 'warning',
    message: client.systemPrompt
           ? 'Knowledge base configured'
           : 'No system prompt. AI responses will be generic.',
    fix:     'Settings → AI → Write a system prompt'
  });

  // Payment
  checks.push({
    name:    'Payment Gateway',
    status:  client.razorpayKeyId || client.cashfreeAppId ? 'ok' : 'warning',
    message: client.razorpayKeyId  ? 'Razorpay connected'
           : client.cashfreeAppId  ? 'Cashfree connected'
           : 'No payment gateway',
    fix:     'Settings → Financials'
  });

  // Templates
  const approved = (client.syncedMetaTemplates || []).filter(t => t.status === 'APPROVED');
  checks.push({
    name:    'Approved Templates',
    status:  approved.length > 0 ? 'ok' : 'warning',
    message: approved.length > 0
           ? `${approved.length} approved template(s)`
           : 'No approved templates',
    fix:     'Template Studio → Create and get templates approved'
  });

  const overallStatus = checks.some(c => c.status === 'error')   ? 'error'
                      : checks.some(c => c.status === 'warning') ? 'warning'
                      : 'ok';

  return { overallStatus, checks };
}

module.exports = {
  validateTemplateForSend,
  validateEmailConfig,
  validateCampaign,
  validateFlowNode,
  validateAutomationFlow,
  getSystemHealth
};
