'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo } = require('../helpers/memoryMongo');
const OptInTool = require('../../models/OptInTool');
const {
  buildToolConversionReport,
  reportToCsv,
  recordImpression,
  rollupOptInAnalyticsForTool,
  RETENTION_DAYS,
} = require('../../services/optInAnalyticsService');

const CLIENT = 'optin_analytics_tenant';

describe('optInAnalyticsService', () => {
  let toolId;

  before(async () => {
    await startMemoryMongo();
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'Welcome popup',
      type: 'popup',
      status: 'live',
      impressions: {
        total: 12,
        byDay: {
          '2099-01-01': 5,
          '2099-01-02': 7,
        },
      },
      signups: {
        total: 3,
        byDay: {
          '2099-01-02': 3,
        },
      },
      analytics: {
        topPages: new Map([['__products__', 8]]),
        devices: { mobile: 4, desktop: 8 },
      },
    });
    toolId = String(tool._id);
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('recordImpression increments views, page, and device', async () => {
    await recordImpression(CLIENT, toolId, {
      pageUrl: 'https://shop.test/collections/sale',
      isMobile: true,
    });
    const tool = await OptInTool.findById(toolId).lean();
    assert.equal(tool.impressions.total, 13);
    assert.equal(tool.analytics.devices.mobile, 5);
    const pages = tool.analytics.topPages instanceof Map
      ? Object.fromEntries(tool.analytics.topPages)
      : tool.analytics.topPages;
    assert.ok(Number(pages['__collections__sale']) >= 1);
  });

  it('buildToolConversionReport returns honest summary and daily series', async () => {
    const report = await buildToolConversionReport(CLIENT, toolId);
    assert.ok(report);
    assert.equal(report.summary.views, 13);
    assert.equal(report.summary.signups, 3);
    assert.ok(report.daily.length === 30);
    assert.ok(report.topPages.length >= 1);
    assert.equal(report.devices.mobile, 5);
  });

  it('reportToCsv includes daily rows', () => {
    const csv = reportToCsv({
      tool: { name: 'Test' },
      summary: { views: 10, signups: 2, signupRate: 20 },
      daily: [{ date: '2026-06-01', views: 10, signups: 2 }],
      topPages: [{ page: '/products', views: 10 }],
      prizeDistribution: [],
    });
    assert.match(csv, /date,views,signups/);
    assert.match(csv, /2026-06-01,10,2/);
  });

  it('rollupOptInAnalyticsForTool prunes byDay older than retention', async () => {
    const oldDay = new Date();
    oldDay.setUTCDate(oldDay.getUTCDate() - (RETENTION_DAYS + 5));
    const stale = oldDay.toISOString().slice(0, 10);
    await OptInTool.updateOne(
      { _id: toolId },
      { $set: { [`impressions.byDay.${stale}`]: 99 } }
    );
    const tool = await OptInTool.findById(toolId).lean();
    const result = await rollupOptInAnalyticsForTool(tool);
    assert.equal(result.pruned, true);
    const after = await OptInTool.findById(toolId).lean();
    const byDay = after.impressions.byDay instanceof Map ? Object.fromEntries(after.impressions.byDay) : after.impressions.byDay;
    assert.equal(byDay[stale], undefined);
    assert.equal(after.impressions.total, 13);
  });
});
