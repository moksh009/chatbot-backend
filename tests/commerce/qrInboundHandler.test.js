'use strict';

const assert = require('assert');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');

async function testExtractQrShortCodeFromText() {
  const { extractQrShortCodeFromText } = require('../../utils/commerce/qrInboundHandler');

  assert.strictEqual(
    extractQrShortCodeFromText('hi moksh here (Ref: QR_31F03D18)'),
    'QR_31F03D18'
  );
  assert.strictEqual(
    extractQrShortCodeFromText('Hi! I\'d like to connect. (Ref: QR_A1B2C3D4)'),
    'QR_A1B2C3D4'
  );
  assert.strictEqual(extractQrShortCodeFromText('QR_DEADBEEF'), 'QR_DEADBEEF');
  assert.strictEqual(extractQrShortCodeFromText('just testing'), null);
}

async function testRecordQrScanStatsIncrements() {
  const QRCode = require('../../models/QRCode');
  const { recordQrScanStats } = require('../../utils/commerce/qrInboundHandler');

  const clientId = `qr_scan_${Date.now()}`;
  const qr = await QRCode.create({
    clientId,
    name: 'Scan test',
    shortCode: 'QR_SCAN001',
    waLink: 'https://wa.me/919999999999',
  });

  const first = await recordQrScanStats(qr._id, '9198888777666', clientId);
  assert.strictEqual(first.isUnique, true);
  assert.strictEqual(first.qr.scansTotal, 1);
  assert.strictEqual(first.qr.scansUnique, 1);

  const second = await recordQrScanStats(qr._id, '9198888777666', clientId);
  assert.strictEqual(second.isUnique, false);
  assert.strictEqual(second.qr.scansTotal, 2);
  assert.strictEqual(second.qr.scansUnique, 1);
}

async function main() {
  await startMemoryMongo();
  try {
    await clearCollections();
    await testExtractQrShortCodeFromText();
    await clearCollections();
    await testRecordQrScanStatsIncrements();
    console.log('✓ qrInboundHandler tests passed');
  } finally {
    await stopMemoryMongo();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
