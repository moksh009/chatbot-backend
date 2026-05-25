const Client = require('../../../models/Client');
const MetaTemplate = require('../../../models/MetaTemplate');

function intentToCategory(intent) {
  if (intent === 'marketing') return 'MARKETING';
  if (intent === 'authentication') return 'AUTHENTICATION';
  if (intent === 'utility' || intent === 'transactional' || intent === 'service') return 'UTILITY';
  return 'UTILITY';
}

function templateCacheKey(clientId, templateName) {
  return `tmpl:${clientId}:${templateName}`;
}

function isSyncedApproved(tpl) {
  return tpl && String(tpl.status || '').toUpperCase() === 'APPROVED';
}

function isMetaTemplateApproved(doc) {
  return doc && String(doc.submissionStatus || '').toLowerCase() === 'approved';
}

function categoryFromRecord(record, intent) {
  if (!record) return null;
  if (record.category) return String(record.category).toUpperCase();
  if (record.templateCategory) return String(record.templateCategory).toUpperCase();
  return intentToCategory(intent);
}

/**
 * Lookup order: Redis → MetaTemplate → Client.syncedMetaTemplates.
 * Never assume APPROVED on miss.
 */
async function checkTemplateApproval({ redis, clientId, payload, intent }) {
  if (!payload?.templateName) return { pass: true };

  const templateName = payload.templateName;
  const language = payload.templateLanguage || payload.language || 'en';
  const cacheKey = templateCacheKey(clientId, templateName);

  let category = null;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        if (cached === '__BLOCKED__') {
          return { pass: false, blockedBy: 'template_not_approved', reason: 'template_not_approved' };
        }
        category = cached;
      }
    } catch (redisErr) {
      return {
        pass: false,
        blockedBy: 'template_not_approved',
        reason: 'check_failed',
      };
    }
  }

  if (!category) {
    let metaDoc;
    try {
      metaDoc = await MetaTemplate.findOne({
        clientId,
        name: templateName,
        language,
        submissionStatus: 'approved',
      })
        .select('category submissionStatus name language')
        .lean();

      if (!metaDoc) {
        metaDoc = await MetaTemplate.findOne({
          clientId,
          name: templateName,
          submissionStatus: 'approved',
        })
          .sort({ updatedAt: -1 })
          .select('category submissionStatus name language')
          .lean();
      }

      if (isMetaTemplateApproved(metaDoc)) {
        category = categoryFromRecord(metaDoc, intent);
      } else {
        const client = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
        const synced = (client?.syncedMetaTemplates || []).find((t) => t?.name === templateName);
        if (isSyncedApproved(synced)) {
          category = categoryFromRecord(synced, intent);
        }
      }

      if (!category) {
        if (redis) {
          try {
            await redis.set(cacheKey, '__BLOCKED__', 'EX', 120);
          } catch {
            /* ignore cache write failure */
          }
        }
        return { pass: false, blockedBy: 'template_not_approved', reason: 'template_not_approved' };
      }

      if (redis) {
        try {
          await redis.set(cacheKey, category, 'EX', 300);
        } catch {
          /* ignore cache write failure */
        }
      }
    } catch (lookupErr) {
      return {
        pass: false,
        blockedBy: 'template_not_approved',
        reason: 'check_failed',
      };
    }
  }

  const expected = intentToCategory(intent);
  if (expected !== category) {
    return {
      pass: false,
      blockedBy: 'template_not_approved',
      reason: `intent_template_mismatch:${expected}:${category}`,
    };
  }
  return { pass: true, templateCategory: category };
}

module.exports = { checkTemplateApproval, templateCacheKey, intentToCategory };
