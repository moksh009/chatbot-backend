"use strict";

const catalog = require("./catalog");
const resolveSlots = require("./resolveSlots");
const sendPolicy = require("./sendPolicy");

module.exports = {
  ...catalog,
  ...resolveSlots,
  ...sendPolicy,
};
