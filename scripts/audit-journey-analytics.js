/**
 * audit-journey-analytics.js
 *
 * Dump journey enrollment analytics for a given clientId + flowId.
 * Compares aggregate stats vs sum-of-recipients to surface mismatches.
 *
 * Usage:
 *   node scripts/audit-journey-analytics.js <clientId> <sourceFlowId> [period=7d]
 *   node scripts/audit-journey-analytics.js delitech_smarthomes abc123 all
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

async function main() {
  const [, , clientId, sourceFlowId, period = '7d'] = process.argv;
  if (!clientId || !sourceFlowId) {
    console.error('Usage: node audit-journey-analytics.js <clientId> <sourceFlowId> [period]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const FollowUpSequence = require('../models/FollowUpSequence');
  const JourneyRevenueAttribution = require('../models/JourneyRevenueAttribution');

  function parsePeriod(p) {
    const now = new Date();
    if (!p || p === 'all') return { from: new Date(0), to: now };
    const match = String(p).match(/^(\d+)([dhm])$/);
    if (!match) return { from: new Date(0), to: now };
    const [, n, unit] = match;
    const ms = { d: 86400e3, h: 3600e3, m: 60e3 }[unit] * Number(n);
    return { from: new Date(Date.now() - ms), to: now };
  }

  const { from, to } = parsePeriod(period);

  const enrollMatch = {
    clientId,
    sourceFlowId,
    createdAt: { $gte: from, $lte: to },
  };

  const sequences = await FollowUpSequence.find(enrollMatch)
    .select('leadId phone email status steps createdAt')
    .lean();

  console.log(`=== Journey Audit: ${clientId} / ${sourceFlowId} [${period}] ===`);
  console.log(`Enrollments found: ${sequences.length}\n`);

  if (!sequences.length) {
    await mongoose.disconnect();
    return;
  }

  // Per-sequence detail
  let totals = { sent: 0, delivered: 0, read: 0, clicked: 0, failed: 0, skipped: 0, pending: 0 };
  let nodeIdMissing = 0;
  let stepCountByIndex = {};

  for (const seq of sequences) {
    const stepSummary = (seq.steps || []).map((s, idx) => {
      const st = String(s.status || 'pending');
      const sent = st === 'sent' || !!s.sentAt;
      const failed = st === 'failed';
      const skipped = st === 'skipped';
      const pending = ['pending', 'queued', 'processing', 'retrying'].includes(st);

      if (!s.graphNodeId) nodeIdMissing++;

      if (!stepCountByIndex[idx]) {
        stepCountByIndex[idx] = { sent: 0, delivered: 0, read: 0, clicked: 0, failed: 0, skipped: 0, pending: 0 };
      }
      const sc = stepCountByIndex[idx];
      if (sent) { totals.sent++; sc.sent++; }
      if (failed) { totals.failed++; sc.failed++; }
      if (skipped) { totals.skipped++; sc.skipped++; }
      if (pending) { totals.pending++; sc.pending++; }
      if (s.deliveredAt) { totals.delivered++; sc.delivered++; }
      if (s.readAt) { totals.read++; sc.read++; }
      if (s.clickedAt) { totals.clicked++; sc.clicked++; }

      return {
        idx,
        type: s.type || s.channel || '?',
        status: st,
        sent: sent ? 'Y' : '-',
        failed: failed ? 'Y' : '-',
        skipped: skipped ? 'Y' : '-',
        messageId: s.messageId ? s.messageId.slice(-6) : '-',
        graphNodeId: s.graphNodeId || '(none)',
        sentAt: s.sentAt ? s.sentAt.toISOString().slice(0, 19) : '-',
        deliveredAt: s.deliveredAt ? s.deliveredAt.toISOString().slice(0, 19) : '-',
        readAt: s.readAt ? s.readAt.toISOString().slice(0, 19) : '-',
        failedAt: s.failedAt ? s.failedAt.toISOString().slice(0, 19) : '-',
        failureReason: s.failureReason || '-',
      };
    });

    console.log(`Enrollment ${seq._id} | ${seq.phone || seq.email || 'no contact'} | seq.status=${seq.status}`);
    console.table(stepSummary);
  }

  // Funnel by step index
  console.log('\n=== Funnel by step index ===');
  const funnelRows = Object.entries(stepCountByIndex)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([idx, c]) => ({ stepIndex: Number(idx), ...c }));
  console.table(funnelRows);

  // Totals
  console.log('\n=== Aggregate totals ===');
  console.table([totals]);

  if (nodeIdMissing > 0) {
    console.log(`\n⚠️  ${nodeIdMissing} steps missing graphNodeId — canvas overlay will not map correctly`);
  }

  // Revenue
  const revRows = await JourneyRevenueAttribution.find({ clientId, sourceFlowId }).lean();
  console.log(`\n=== Revenue attributions: ${revRows.length} rows ===`);
  if (revRows.length) {
    console.table(revRows.map(r => ({
      leadId: String(r.leadId || '-'),
      amount: r.amount,
      orderId: r.orderId || '-',
      attributedAt: r.attributedAt ? r.attributedAt.toISOString().slice(0, 10) : '-',
      excluded: r.excluded || false,
    })));
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
