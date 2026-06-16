"use strict";

const assert = require("assert");
const { normalizeMetaId } = require("../utils/meta/whatsappMetaValidate");

function run() {
  assert.equal(normalizeMetaId(" 1001467039715239 "), "1001467039715239");
  assert.equal(normalizeMetaId('"103984012345678"'), "103984012345678");
  assert.equal(normalizeMetaId("10 3984 0123 45678"), "103984012345678");
  assert.equal(normalizeMetaId(""), "");
  console.log("whatsappMetaValidate tests passed");
}

run();
