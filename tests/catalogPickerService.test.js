"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  mapPickerCollection,
  SAMPLE_PICKER_COLLECTIONS,
} = require("../utils/commerce/catalogPickerService");

test("mapPickerCollection prefers live aggregated count over stale field", () => {
  const row = { shopifyCollectionId: "123", title: "Doorphone", productsCount: 0 };
  const mapped = mapPickerCollection(row, 14);
  assert.equal(mapped.id, "123");
  assert.equal(mapped.productsCount, 14);
});

test("mapPickerCollection falls back to stored count when no live count", () => {
  const row = { shopifyCollectionId: "456", title: "Bundles", productsCount: 7 };
  const mapped = mapPickerCollection(row, undefined);
  assert.equal(mapped.productsCount, 7);
});

test("sample collections have non-zero counts for disconnected preview", () => {
  assert.ok(SAMPLE_PICKER_COLLECTIONS.every((c) => c.productsCount > 0));
});
