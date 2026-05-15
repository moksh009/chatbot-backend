"use strict";

const assert = require("assert");
const {
  splitCollectionsForWhatsAppMenu,
  MORE_ROW_ID,
  MAX_EXPLORE_MENU_ROWS,
} = require("../utils/catalogMenuBuilder");

function makeCols(n) {
  return Array.from({ length: n }, (_, i) => ({
    shopifyCollectionId: String(1000 + i),
    title: `Collection ${i + 1}`,
    productsCount: n - i,
  }));
}

function run() {
  const small = splitCollectionsForWhatsAppMenu(makeCols(8));
  assert.equal(small.hasOverflow, false);
  assert.equal(small.allCollections.length, 8);
  assert.equal(small.primarySections.length >= 1, true);

  const large = splitCollectionsForWhatsAppMenu(makeCols(15));
  assert.equal(large.hasOverflow, true, "15 collections should trigger overflow menu");
  assert.equal(large.primary.length, 9, "primary holds 9 + More row");
  assert.equal(large.overflow.length, 6, "15 - 9 = 6 overflow");
  assert.equal(large.moreRowId, MORE_ROW_ID);

  const moreRow = large.primarySections
    .flatMap((s) => s.rows)
    .find((r) => r.id === MORE_ROW_ID);
  assert.ok(moreRow, "More categories row on page 1");
  assert.ok(String(moreRow.title).toLowerCase().includes("more"));

  assert.equal(large.overflowSections.flatMap((s) => s.rows).length, 6);
  assert.ok(large.overflowSections.flatMap((s) => s.rows).length <= MAX_EXPLORE_MENU_ROWS);

  console.log("catalogMenuBuilder tests passed");
}

run();
