#!/usr/bin/env node
'use strict';

/**
 * Backfill phone fields to E.164 (+CC…) across core collections.
 * Dry-run by default — pass --apply to write updates.
 *
 * Unique-index collections (conversations, adleads, contacts) are deduped
 * by (scopeField, E.164) before normalization to avoid E11000 collisions.
 *
 *   node scripts/backfillPhoneE164.js
 *   node scripts/backfillPhoneE164.js --apply
 *   node scripts/backfillPhoneE164.js --apply --clientId=acme_123
 */

require('dotenv').config();
const mongoose = require('mongoose');
require('../mongoose/phoneE164Plugin').registerPhoneE164GlobalPlugin();

const { sanitizePhoneForStorage } = require('../utils/core/phoneE164Policy');

const APPLY = process.argv.includes('--apply');
const clientArg = process.argv.find((a) => a.startsWith('--clientId='));
const CLIENT_FILTER = clientArg ? clientArg.split('=')[1] : null;

/** Collections with compound unique index on scope + phone field. */
const UNIQUE_SCOPE_JOBS = [
  {
    collection: 'conversations',
    field: 'phone',
    scopeField: 'clientId',
    pickCanonical: pickConversationCanonical,
    onMerge: mergeConversationDuplicate,
  },
  {
    collection: 'adleads',
    field: 'phoneNumber',
    scopeField: 'clientId',
    pickCanonical: pickLeadCanonical,
    onMerge: mergeLeadDuplicate,
  },
  {
    collection: 'contacts',
    field: 'phoneNumber',
    scopeField: 'clientId',
    pickCanonical: pickLeadCanonical,
    onMerge: mergeContactDuplicate,
  },
];

const SIMPLE_JOBS = [
  { collection: 'orders', fields: ['customerPhone', 'phone'], scopeField: 'clientId' },
  { collection: 'campaignmessages', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'messages', fields: ['from', 'to'], scopeField: 'clientId' },
  { collection: 'users', fields: ['phone'], scopeField: null },
  { collection: 'visitoridentities', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'scheduledmessages', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'suppressionlists', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'customerintelligences', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'qrscans', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'ndractions', fields: ['customerPhone'], scopeField: 'clientId' },
  { collection: 'orderstatussents', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'checkoutlinks', fields: ['phone'], scopeField: 'clientId' },
];

function ts(doc) {
  const d = doc.lastMessageAt || doc.updatedAt || doc.createdAt || doc.lastInteraction;
  return d ? new Date(d).getTime() : 0;
}

function pickConversationCanonical(a, b) {
  return ts(a) >= ts(b) ? a : b;
}

function pickLeadCanonical(a, b) {
  const aT = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const bT = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return aT >= bT ? a : b;
}

async function mergeConversationDuplicate(coll, canonical, duplicate, e164, stats) {
  const Message = mongoose.connection.collection('messages');
  if (APPLY) {
    await Message.updateMany(
      { conversationId: duplicate._id },
      { $set: { conversationId: canonical._id } }
    );
    const mergeSet = {};
    if (!canonical.customerName && duplicate.customerName) mergeSet.customerName = duplicate.customerName;
    if ((duplicate.unreadCount || 0) > (canonical.unreadCount || 0)) {
      mergeSet.unreadCount = duplicate.unreadCount;
    }
    if (duplicate.lastMessageAt && ts(duplicate) > ts(canonical)) {
      mergeSet.lastMessageAt = duplicate.lastMessageAt;
      if (duplicate.lastMessage) mergeSet.lastMessage = duplicate.lastMessage;
    }
    const tags = [...new Set([...(canonical.tags || []), ...(duplicate.tags || [])])];
    if (tags.length) mergeSet.tags = tags;
    // Delete duplicate before any phone write — unique index is (clientId, phone).
    await coll.deleteOne({ _id: duplicate._id });
    if (Object.keys(mergeSet).length) {
      await coll.updateOne({ _id: canonical._id }, { $set: mergeSet });
    }
  }
  stats.mergeDetails.push({
    collection: 'conversations',
    canonicalId: String(canonical._id),
    duplicateId: String(duplicate._id),
    clientId: canonical.clientId,
    e164,
    dupPhone: duplicate.phone,
  });
}

async function mergeLeadDuplicate(coll, canonical, duplicate, e164, stats) {
  if (APPLY) {
    const mergeSet = {};
    if (!canonical.name && duplicate.name) mergeSet.name = duplicate.name;
    if (!canonical.email && duplicate.email) mergeSet.email = duplicate.email;
    const tags = [...new Set([...(canonical.tags || []), ...(duplicate.tags || [])])];
    if (tags.length) mergeSet.tags = tags;
    await coll.deleteOne({ _id: duplicate._id });
    if (Object.keys(mergeSet).length) {
      await coll.updateOne({ _id: canonical._id }, { $set: mergeSet });
    }
  }
  stats.mergeDetails.push({
    collection: 'adleads',
    canonicalId: String(canonical._id),
    duplicateId: String(duplicate._id),
    clientId: canonical.clientId,
    e164,
    dupPhone: duplicate.phoneNumber,
  });
}

async function mergeContactDuplicate(coll, canonical, duplicate, e164, stats) {
  if (APPLY) {
    const mergeSet = {};
    if (!canonical.name && duplicate.name) mergeSet.name = duplicate.name;
    if (!canonical.email && duplicate.email) mergeSet.email = duplicate.email;
    await coll.deleteOne({ _id: duplicate._id });
    if (Object.keys(mergeSet).length) {
      await coll.updateOne({ _id: canonical._id }, { $set: mergeSet });
    }
  }
  stats.mergeDetails.push({
    collection: 'contacts',
    canonicalId: String(canonical._id),
    duplicateId: String(duplicate._id),
    clientId: canonical.clientId,
    e164,
    dupPhone: duplicate.phoneNumber,
  });
}

/**
 * Group docs by scope + E.164, merge duplicates, normalize singles.
 */
async function backfillUniqueScope(job, baseFilter, stats) {
  const coll = mongoose.connection.collection(job.collection);
  const { field, scopeField } = job;
  const query = { ...baseFilter, [field]: { $exists: true, $nin: [null, ''] } };
  const docs = await coll.find(query).toArray();

  const groups = new Map();
  let scanned = 0;
  let skipped = 0;

  for (const doc of docs) {
    scanned += 1;
    const raw = doc[field];
    if (!raw || typeof raw !== 'string') {
      skipped += 1;
      continue;
    }
    const e164 = sanitizePhoneForStorage(raw);
    if (!e164) {
      skipped += 1;
      continue;
    }
    const scope = scopeField ? String(doc[scopeField] || '') : '_global';
    const key = `${scope}::${e164}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ doc, e164, raw });
  }

  let updated = 0;
  const mergedBefore = stats.mergeDetails.length;

  for (const [, members] of groups) {
    if (members.length > 1) {
      let canonical = members[0].doc;
      for (let i = 1; i < members.length; i += 1) {
        canonical = job.pickCanonical(canonical, members[i].doc);
      }
      const e164 = members[0].e164;
      for (const { doc } of members) {
        if (String(doc._id) === String(canonical._id)) continue;
        try {
          await job.onMerge(coll, canonical, doc, e164, stats);
        } catch (err) {
          if (err.code === 11000) {
            stats.collisions += 1;
            stats.collisionDetails.push({
              collection: job.collection,
              id: String(doc._id),
              canonicalId: String(canonical._id),
              e164,
              message: err.message,
            });
            continue;
          }
          throw err;
        }
      }
      const canonicalRaw = canonical[field];
      if (canonicalRaw !== e164) {
        if (APPLY) {
          try {
            await coll.updateOne({ _id: canonical._id }, { $set: { [field]: e164 } });
          } catch (err) {
            if (err.code === 11000) {
              const scope = scopeField ? String(canonical[scopeField] || '') : '_global';
              const existing = await coll.findOne({
                _id: { $ne: canonical._id },
                ...(scopeField ? { [scopeField]: scope } : {}),
                [field]: e164,
              });
              if (existing) {
                await job.onMerge(coll, existing, canonical, e164, stats);
              } else {
                stats.collisions += 1;
                stats.collisionDetails.push({
                  collection: job.collection,
                  id: String(canonical._id),
                  scope,
                  e164,
                  message: err.message,
                });
              }
              continue;
            }
            throw err;
          }
        }
        updated += 1;
      }
      continue;
    }

    const { doc, e164, raw } = members[0];
    if (e164 === raw) {
      skipped += 1;
      continue;
    }

    const scope = scopeField ? String(doc[scopeField] || '') : '_global';
    const conflict = await coll.findOne({
      _id: { $ne: doc._id },
      ...(scopeField ? { [scopeField]: scope } : {}),
      [field]: e164,
    });
    if (conflict) {
      try {
        await job.onMerge(coll, conflict, doc, e164, stats);
      } catch (err) {
        if (err.code === 11000) {
          stats.collisions += 1;
          stats.collisionDetails.push({
            collection: job.collection,
            id: String(doc._id),
            canonicalId: String(conflict._id),
            e164,
            message: err.message,
          });
          continue;
        }
        throw err;
      }
      continue;
    }

    if (APPLY) {
      try {
        const res = await coll.updateOne({ _id: doc._id }, { $set: { [field]: e164 } });
        if (res.matchedCount === 0) {
          skipped += 1;
          continue;
        }
      } catch (err) {
        if (err.code === 11000) {
          const existing = await coll.findOne({
            ...(scopeField ? { [scopeField]: scope } : {}),
            [field]: e164,
          });
          if (existing) {
            await job.onMerge(coll, existing, doc, e164, stats);
            continue;
          }
          stats.collisions += 1;
          stats.collisionDetails.push({
            collection: job.collection,
            id: String(doc._id),
            scope,
            e164,
            message: err.message,
          });
          continue;
        }
        throw err;
      }
    }
    updated += 1;
  }

  const merged = stats.mergeDetails.length - mergedBefore;
  console.log(
    `${job.collection}.${field}: scanned=${scanned} updated=${updated} skipped=${skipped} merged=${merged}`
  );
}

async function backfillSimpleFields(job, baseFilter, stats) {
  const coll = mongoose.connection.collection(job.collection);
  const fields = job.fields || [];
  const scopeField = job.scopeField;

  for (const field of fields) {
    const query = { ...baseFilter, [field]: { $exists: true, $nin: [null, ''] } };
    const cursor = coll.find(query).project({ [field]: 1, clientId: 1 });
    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    for await (const doc of cursor) {
      scanned += 1;
      const raw = doc[field];
      if (!raw || typeof raw !== 'string') {
        skipped += 1;
        continue;
      }
      const e164 = sanitizePhoneForStorage(raw);
      if (!e164 || e164 === raw) {
        skipped += 1;
        continue;
      }

      if (APPLY) {
        try {
          await coll.updateOne({ _id: doc._id }, { $set: { [field]: e164 } });
        } catch (err) {
          if (err.code === 11000) {
            stats.collisions += 1;
            stats.collisionDetails.push({
              collection: job.collection,
              field,
              id: String(doc._id),
              e164,
              message: err.message,
            });
            continue;
          }
          throw err;
        }
      }
      updated += 1;
    }

    console.log(
      `${job.collection}.${field}: scanned=${scanned} updated=${updated} skipped=${skipped}`
    );
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`[backfillPhoneE164] mode=${APPLY ? 'APPLY' : 'DRY_RUN'} clientId=${CLIENT_FILTER || 'ALL'}`);

  const baseFilter = CLIENT_FILTER ? { clientId: CLIENT_FILTER } : {};
  const stats = {
    mergeDetails: [],
    collisions: 0,
    collisionDetails: [],
  };

  for (const job of UNIQUE_SCOPE_JOBS) {
    await backfillUniqueScope(job, baseFilter, stats);
  }

  for (const job of SIMPLE_JOBS) {
    await backfillSimpleFields(job, baseFilter, stats);
  }

  if (stats.mergeDetails.length) {
    console.log(`[backfillPhoneE164] duplicate merges=${stats.mergeDetails.length}`);
    for (const d of stats.mergeDetails.slice(0, 20)) {
      console.log(`  merge ${d.collection} ${d.clientId} ${d.dupPhone} -> ${d.e164} (kept ${d.canonicalId}, removed ${d.duplicateId})`);
    }
    if (stats.mergeDetails.length > 20) {
      console.log(`  ... and ${stats.mergeDetails.length - 20} more`);
    }
  }

  if (stats.collisions) {
    console.warn(`[backfillPhoneE164] unresolved collisions=${stats.collisions}`);
    for (const c of stats.collisionDetails.slice(0, 10)) {
      console.warn(`  collision ${c.collection} ${c.id} ${c.e164}: ${c.message}`);
    }
  }

  await mongoose.disconnect();
  console.log('[backfillPhoneE164] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
