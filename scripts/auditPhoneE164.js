#!/usr/bin/env node
'use strict';

/**
 * Audit phone fields — report values that are not compact E.164 (+CC…, no spaces).
 *
 *   node scripts/auditPhoneE164.js
 *   node scripts/auditPhoneE164.js --clientId=delitech_smarthomes
 *   node scripts/auditPhoneE164.js --limit=20
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { sanitizePhoneForStorage } = require('../utils/core/phoneE164Policy');

const clientArg = process.argv.find((a) => a.startsWith('--clientId='));
const CLIENT_FILTER = clientArg ? clientArg.split('=')[1] : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const SAMPLE_LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 15;

const JOBS = [
  { collection: 'conversations', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'adleads', fields: ['phoneNumber'], scopeField: 'clientId' },
  { collection: 'contacts', fields: ['phoneNumber'], scopeField: 'clientId' },
  { collection: 'orders', fields: ['customerPhone', 'phone'], scopeField: 'clientId' },
  { collection: 'messages', fields: ['from', 'to'], scopeField: 'clientId' },
  { collection: 'visitoridentities', fields: ['phone'], scopeField: 'clientId' },
  { collection: 'campaignmessages', fields: ['phone'], scopeField: 'clientId' },
];

function isCompactE164(value) {
  if (value == null || value === '') return true;
  const s = String(value).trim();
  if (!s) return true;
  if (/\s/.test(s)) return false;
  if (!s.startsWith('+')) return false;
  const digits = s.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return false;
  return sanitizePhoneForStorage(s) === s;
}

async function auditCollection(db, job) {
  const coll = db.collection(job.collection);
  const filter = {};
  if (CLIENT_FILTER && job.scopeField) filter[job.scopeField] = CLIENT_FILTER;

  const or = job.fields.map((f) => ({ [f]: { $exists: true, $nin: [null, ''] } }));
  if (or.length) filter.$or = or;

  let scanned = 0;
  let invalid = 0;
  const samples = [];

  const cursor = coll.find(filter).project(
    Object.fromEntries([...(job.scopeField ? [[job.scopeField, 1]] : []), ...job.fields.map((f) => [f, 1])])
  );

  for await (const doc of cursor) {
    scanned += 1;
    for (const field of job.fields) {
      const raw = doc[field];
      if (raw == null || raw === '') continue;
      if (isCompactE164(raw)) continue;
      invalid += 1;
      if (samples.length < SAMPLE_LIMIT) {
        const expected = sanitizePhoneForStorage(raw);
        samples.push({
          id: String(doc._id),
          clientId: job.scopeField ? doc[job.scopeField] : undefined,
          field,
          raw: String(raw),
          expected: expected || '(unparseable)',
        });
      }
    }
  }

  return { collection: job.collection, scanned, invalid, samples };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log(`[auditPhoneE164] clientId=${CLIENT_FILTER || 'ALL'}`);
  let totalInvalid = 0;

  for (const job of JOBS) {
    const result = await auditCollection(db, job);
    totalInvalid += result.invalid;
    console.log(
      `${result.collection}: scanned=${result.scanned} invalid=${result.invalid}`
    );
    for (const s of result.samples) {
      console.log(`  ${s.clientId || '—'} ${s.field}: "${s.raw}" → "${s.expected}"`);
    }
  }

  console.log(`[auditPhoneE164] total invalid field values=${totalInvalid}`);
  if (totalInvalid > 0) {
    console.log('[auditPhoneE164] Run: node scripts/backfillPhoneE164.js --apply');
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
