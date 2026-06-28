"use strict";

const assert = require("assert");
const {
  buildInsertableCatalogBranch,
} = require("../utils/flow/catalogBranchBuilder");
const { splitCollectionsForWhatsAppMenu } = require("../utils/commerce/catalogMenuBuilder");

function makeProducts(n, collectionId) {
  return Array.from({ length: n }, (_, i) => ({
    shopifyVariantId: String(10000 + i),
    title: `Product ${i + 1}`,
    inStock: true,
    collectionIds: collectionId ? [String(collectionId)] : [],
    category: `Type${i % 3}`,
    productType: `Type${i % 3}`,
  }));
}

function makeCollections(n) {
  return Array.from({ length: n }, (_, i) => ({
    shopifyCollectionId: String(2000 + i),
    title: i === 0 ? "Best Sellers" : `Collection ${i + 1}`,
    productsCount: n - i,
    whatsappEnabled: true,
  }));
}

function run() {
  const ctx5 = {
    products: makeProducts(20, "2000").concat(makeProducts(5, "2001")),
    mpmTemplateName: "carosuel",
    useCollections: true,
    menuSplit: splitCollectionsForWhatsAppMenu(makeCollections(5)),
    buckets: [],
    catalogLinked: true,
  };
  const g5 = buildInsertableCatalogBranch(ctx5, { seed: 1, nextNodeOrder: 1 });
  assert.equal(g5.nodes.filter((n) => n.type === "catalog").length, 5);
  assert.ok(g5.entryNodeId);

  const split15 = splitCollectionsForWhatsAppMenu(makeCollections(15));
  const products15 = [];
  for (let i = 0; i < 15; i++) {
    products15.push(...makeProducts(3, String(2000 + i)));
  }
  const ctx15 = {
    products: products15,
    mpmTemplateName: "carosuel",
    useCollections: true,
    menuSplit: split15,
    buckets: [],
    catalogLinked: true,
  };
  const g15 = buildInsertableCatalogBranch(ctx15, { seed: 2, nextNodeOrder: 1 });
  assert.equal(g15.nodes.filter((n) => n.type === "catalog").length, 15);
  assert.ok(g15.overflowNodeId);

  const prods = makeProducts(12);
  const buckets = new Map();
  prods.forEach((p) => {
    const k = p.productType;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  });
  const ctxBucket = {
    products: prods,
    mpmTemplateName: "carosuel",
    useCollections: false,
    menuSplit: null,
    buckets: Array.from(buckets.entries()),
    catalogLinked: false,
  };
  const gBucket = buildInsertableCatalogBranch(ctxBucket, { seed: 3, nextNodeOrder: 1 });
  assert.ok(gBucket.nodes.filter((n) => n.type === "catalog").length >= 1);
  assert.ok(gBucket.nodes.some((n) => n.type === "message" && String(n.id).includes("no_catalog")));

  console.log("catalogBranchBuilder tests passed");
}

run();
