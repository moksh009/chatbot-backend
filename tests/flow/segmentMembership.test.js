'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let Segment;
let AdLead;
let leadMatchesAudienceSegment;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Segment = require('../../models/Segment');
  AdLead = require('../../models/AdLead');
  ({ leadMatchesAudienceSegment } = require('../../services/segmentMembership'));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('leadMatchesAudienceSegment returns true when lead matches saved query', async () => {
  const clientId = 'client_seg_test';
  const lead = await AdLead.create({
    clientId,
    phoneNumber: '919999999999',
    name: 'VIP Buyer',
    leadScore: 900,
  });

  const segment = await Segment.create({
    clientId,
    name: 'High score',
    query: { leadScore: { $gte: 500 } },
  });

  const match = await leadMatchesAudienceSegment(clientId, lead, segment._id);
  assert.equal(match, true);
});

test('leadMatchesAudienceSegment returns false for wrong client or missing lead', async () => {
  const clientId = 'client_seg_test_2';
  const segment = await Segment.create({
    clientId,
    name: 'All',
    query: {},
  });

  assert.equal(await leadMatchesAudienceSegment(clientId, null, segment._id), false);
  assert.equal(await leadMatchesAudienceSegment('other_client', { _id: new mongoose.Types.ObjectId() }, segment._id), false);
});
