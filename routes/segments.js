const express = require('express');
const router = express.Router();
const Segment = require('../models/Segment');
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { translateConditionsToQuery } = require('../services/SegmentQueryBuilder');
const { translateConditionsToQuery: translateTreeQuery } = require('../services/SegmentQueryBuilderV2');
const { apiCache, clearClientCache } = require('../middleware/apiCache');
const { syncOrderBackedCustomersToAdLeads } = require('../utils/commerce/leadsAnalyticsFacet');
const {
  resolveSegmentDefinition,
  resolveSegmentDefinitionForPreview,
  serializeSegment,
} = require('../utils/segmentConditionUtils');
const { bootstrapSystemSegments } = require('../services/segmentPresetBootstrap');
const { refreshAllSegmentCounts } = require('../services/segmentCountSync');
const { filterUnifiedAudience, countUnifiedSegment } = require('../services/segmentAudienceEvaluation');
const { buildSegmentCatalog } = require('../services/segmentCatalogService');

function buildQueryFromPayload(payload) {
  const { conditionTree } = resolveSegmentDefinition(payload);
  return translateTreeQuery(conditionTree);
}

async function ensureAudienceSynced(clientId) {
  await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});
}

function formatSegmentResponse(segment) {
  const doc = serializeSegment(segment.toObject ? segment.toObject() : segment);
  return doc;
}

/**
 * GET /api/segments/catalog
 */
router.get('/catalog', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: 'clientId is required.' });
    }
    const catalog = await buildSegmentCatalog(clientId);
    res.json(catalog);
  } catch (err) {
    console.error('[Segments] catalog error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load segment catalog.' });
  }
});

/**
 * GET /api/segments
 */
router.get('/', protect, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('GET /api/segments', req.user?.clientId || '');
  try {
    const clientId = tenantClientId(req);
    await ensureAudienceSynced(clientId);
    const bootstrapResult = await bootstrapSystemSegments(clientId).catch((err) => {
      console.error('[Segments] Preset bootstrap failed:', err.message);
      return { created: 0, skipped: 0, updated: 0 };
    });
    if (bootstrapResult?.created > 0 || bootstrapResult?.updated > 0) {
      await clearClientCache(clientId).catch(() => {});
    }

    const segments = await Segment.find({ clientId })
      .select('_id name description conditions conditionTree lastCount lastCountAt createdAt updatedAt isSystem presetKey')
      .sort({ isSystem: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    const normalized = segments.map((s) => serializeSegment(s));
    timer.finish(`200 ok | count=${normalized.length}`);
    res.json(normalized);
  } catch (err) {
    timer.finish(`500 ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch segments.' });
  }
});

/**
 * POST /api/segments
 */
router.post('/', protect, async (req, res) => {
  const { name, description } = req.body;
  const clientId = tenantClientId(req);

  if (!name) {
    return res.status(400).json({
      success: false,
      error: 'Missing mandatory field: name is required.',
    });
  }

  try {
    const { conditionTree, conditions } = resolveSegmentDefinition(req.body);
    if (!conditions.length) {
      return res.status(400).json({
        success: false,
        error: 'At least one filter rule is required.',
      });
    }

    const generatedQuery = buildQueryFromPayload({ conditionTree, conditions });
    await ensureAudienceSynced(clientId);
    const { count } = await countUnifiedSegment(clientId, conditionTree);
    const now = new Date();

    const segment = await Segment.create({
      clientId,
      name: String(name).trim(),
      description: description || `Built with ${conditions.length} automatic rules.`,
      conditions,
      conditionTree,
      query: generatedQuery,
      lastCount: count,
      lastCountAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await clearClientCache(clientId);
    res.status(201).json(formatSegmentResponse(segment));
  } catch (err) {
    console.error('[Segments] Create Error:', err);
    res.status(400).json({
      success: false,
      error: 'Schema violation or parsing error: ' + err.message,
    });
  }
});

/**
 * POST /api/segments/preview
 */
router.post('/preview', protect, async (req, res) => {
  const clientId = tenantClientId(req);

  try {
    const { conditionTree, conditions } = resolveSegmentDefinitionForPreview(req.body);
    if (!conditions.length) {
      return res.status(400).json({
        success: false,
        error: 'Add at least one complete filter rule to preview (fill in all required fields).',
      });
    }

    await ensureAudienceSynced(clientId);

    const { count, totalAudience } = await countUnifiedSegment(clientId, conditionTree);
    const { rows: previewRows } = await filterUnifiedAudience(clientId, conditionTree);
    const leads = previewRows.slice(0, 12).map((r) => ({
      _id: r._id,
      name: r.name,
      phoneNumber: r.phoneNumber,
      email: r.email,
      lastInteraction: r.lastInteraction || r.displayLastSeenAt,
      ordersCount: r.ordersCount,
      leadScore: r.leadScore,
      cartStatus: r.cartStatus,
      totalSpent: r.totalSpent,
      optStatus: r.optStatus,
    }));

    const audienceShare = totalAudience > 0 ? Math.round((count / totalAudience) * 1000) / 10 : 0;
    res.json({ success: true, count, totalAudience, audienceShare, leads });
  } catch (err) {
    console.error('[Segments] Preview Error:', err);
    res.status(400).json({ success: false, error: 'Failed to preview segment: ' + err.message });
  }
});

/**
 * POST /api/segments/bootstrap-presets
 * Force-seed or reconcile system presets (called when list is empty).
 */
router.post('/bootstrap-presets', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    await ensureAudienceSynced(clientId);
    const result = await bootstrapSystemSegments(clientId);
    await clearClientCache(clientId);
    const segments = await Segment.find({ clientId })
      .select('_id name description conditions conditionTree lastCount lastCountAt createdAt updatedAt isSystem presetKey')
      .sort({ isSystem: -1, updatedAt: -1, createdAt: -1 })
      .lean();
    res.json({
      success: true,
      ...result,
      segments: segments.map((s) => serializeSegment(s)),
    });
  } catch (err) {
    console.error('[Segments] Bootstrap presets error:', err);
    res.status(500).json({ success: false, error: 'Failed to bootstrap presets.' });
  }
});

/**
 * POST /api/segments/refresh-counts
 */
router.post('/refresh-counts', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const result = await refreshAllSegmentCounts(clientId);
    res.json({ success: true, updated: result.updated });
  } catch (err) {
    console.error('[Segments] Refresh counts error:', err);
    res.status(500).json({ success: false, error: 'Failed to refresh segment counts.' });
  }
});

/**
 * GET /api/segments/:id
 */
router.get('/:id', protect, apiCache(30), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const segment = await Segment.findOne({ _id: req.params.id, clientId }).lean();
    if (!segment) {
      return res.status(404).json({ success: false, error: 'Segment not found' });
    }
    res.json(formatSegmentResponse(segment));
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch segment.' });
  }
});

/**
 * PUT /api/segments/:id
 */
router.put('/:id', protect, async (req, res) => {
  const clientId = tenantClientId(req);
  const { name, description } = req.body;

  try {
    const existing = await Segment.findOne({ _id: req.params.id, clientId });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Segment not found' });
    }

    const { conditionTree, conditions } = resolveSegmentDefinition(req.body);
    if (!conditions.length) {
      return res.status(400).json({ success: false, error: 'At least one filter rule is required.' });
    }

    const generatedQuery = buildQueryFromPayload({ conditionTree, conditions });
    await ensureAudienceSynced(clientId);
    const { count } = await countUnifiedSegment(clientId, conditionTree);
    const now = new Date();

    existing.name = String(name || existing.name).trim();
    existing.description = description != null ? description : existing.description;
    existing.conditions = conditions;
    existing.conditionTree = conditionTree;
    existing.query = generatedQuery;
    existing.lastCount = count;
    existing.lastCountAt = now;
    existing.updatedAt = now;
    await existing.save();
    await clearClientCache(clientId);

    res.json(formatSegmentResponse(existing));
  } catch (err) {
    console.error('[Segments] Update Error:', err);
    res.status(400).json({ success: false, error: 'Failed to update segment: ' + err.message });
  }
});

/**
 * POST /api/segments/:id/duplicate
 */
router.post('/:id/duplicate', protect, async (req, res) => {
  const clientId = tenantClientId(req);
  try {
    const source = await Segment.findOne({ _id: req.params.id, clientId }).lean();
    if (!source) {
      return res.status(404).json({ success: false, error: 'Segment not found' });
    }

    const serialized = serializeSegment(source);
    const now = new Date();
    const copyName = String(req.body?.name || `Copy of ${source.name}`).trim();
    const query = translateTreeQuery(serialized.conditionTree);
    const { count } = await countUnifiedSegment(clientId, serialized.conditionTree);

    const segment = await Segment.create({
      clientId,
      name: copyName,
      description: source.description,
      conditions: serialized.conditions,
      conditionTree: serialized.conditionTree,
      query,
      type: source.type || 'dynamic',
      lastCount: count,
      lastCountAt: now,
      createdAt: now,
      updatedAt: now,
      isSystem: false,
    });

    await clearClientCache(clientId);
    res.status(201).json(formatSegmentResponse(segment));
  } catch (err) {
    console.error('[Segments] Duplicate Error:', err);
    res.status(500).json({ success: false, error: 'Failed to duplicate segment.' });
  }
});

/**
 * POST /api/segments/:id/refresh
 */
router.post('/:id/refresh', protect, async (req, res) => {
  const clientId = tenantClientId(req);
  try {
    const segment = await Segment.findOne({ _id: req.params.id, clientId });
    if (!segment) {
      return res.status(404).json({ success: false, error: 'Segment not found' });
    }

    await ensureAudienceSynced(clientId);
    const serialized = serializeSegment(segment);
    const query = translateTreeQuery(serialized.conditionTree);
    const { count } = await countUnifiedSegment(clientId, serialized.conditionTree);
    const now = new Date();
    segment.query = query;
    segment.conditionTree = serialized.conditionTree;
    segment.conditions = serialized.conditions;
    segment.lastCount = count;
    segment.lastCountAt = now;
    segment.updatedAt = now;
    await segment.save();
    await clearClientCache(clientId);

    res.json({
      success: true,
      lastCount: count,
      lastCountAt: now,
      segment: formatSegmentResponse(segment),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to refresh segment count.' });
  }
});

/**
 * GET /api/segments/:id/leads — paginated members
 */
router.get('/:id/leads', protect, apiCache(45), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('GET /api/segments/:id/leads', req.user?.clientId || '');
  try {
    const clientId = tenantClientId(req);
    const segment = await Segment.findOne({ _id: req.params.id, clientId })
      .select('conditionTree conditions query name')
      .lean();
    if (!segment) {
      timer.finish('404');
      return res.status(404).json({ error: 'Segment not found' });
    }

    await ensureAudienceSynced(clientId);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || '').trim();
    const skip = (page - 1) * limit;

    const { rows: allMatches, totalAudience } = await filterUnifiedAudience(clientId, segment, {
      search,
    });
    const count = allMatches.length;
    const leads = allMatches.slice(skip, skip + limit).map((r) => ({
      _id: r._id,
      name: r.name,
      phoneNumber: r.phoneNumber,
      email: r.email,
      lastInteraction: r.lastInteraction || r.displayLastSeenAt || r.lastInboundAt,
      ordersCount: r.ordersCount ?? 0,
      leadScore: r.leadScore,
      cartStatus: r.cartStatus,
      totalSpent: r.totalSpent ?? r.lifetimeValue ?? 0,
      optStatus: r.optStatus,
      optInSource: r.optInSource,
      tags: r.tags,
    }));

    const totalPages = Math.max(1, Math.ceil(count / limit));
    timer.finish(`200 ok | count=${count} page=${page}`);
    res.json({
      success: true,
      count,
      totalAudience,
      page,
      limit,
      totalPages,
      leads,
    });
  } catch (err) {
    timer.finish(`500 ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to process segment leads.' });
  }
});

/**
 * DELETE /api/segments/:id
 */
router.delete('/:id', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const segment = await Segment.findOne({ _id: req.params.id, clientId }).select('isSystem').lean();
    if (!segment) {
      return res.status(404).json({ success: false, error: 'Segment not found' });
    }
    if (segment.isSystem) {
      return res.status(403).json({ success: false, error: 'System segments cannot be deleted. Duplicate to customize.' });
    }
    await Segment.deleteOne({ _id: req.params.id, clientId });
    await clearClientCache(clientId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete segment.' });
  }
});

module.exports = router;
