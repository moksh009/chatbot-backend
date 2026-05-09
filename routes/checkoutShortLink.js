"use strict";

const express = require("express");
const router = express.Router();
const CheckoutLink = require("../models/CheckoutLink");
const log = require("../utils/logger")("CheckoutShortLink");

router.get("/:shortCode", async (req, res) => {
  try {
    const { shortCode } = req.params;
    const doc = await CheckoutLink.findOne({ shortCode: String(shortCode) }).lean();
    if (!doc?.fullUrl) {
      return res.status(404).type("text/plain").send("Link not found or expired");
    }
    await CheckoutLink.updateOne(
      { _id: doc._id },
      { $set: { clicked: true, clickedAt: new Date() } }
    );
    return res.redirect(302, doc.fullUrl);
  } catch (err) {
    log.error(err.message);
    return res.status(500).type("text/plain").send("Server error");
  }
});

module.exports = router;
