"use strict";

const axios = require("axios");

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Validates WhatsApp Cloud API credentials against Meta Graph.
 * - Always checks GET /{phone-number-id} with the token (send + read scope).
 * - When wabaId is provided, checks that this phone number is listed on that WABA
 *   (prevents SaaS tenants pasting mismatched IDs that would never receive webhooks).
 */
async function validateWhatsAppCloudCredentials({ phoneNumberId, whatsappToken, wabaId }) {
  const pid = String(phoneNumberId || "").trim();
  const tok = String(whatsappToken || "").trim();
  const waba = wabaId != null ? String(wabaId).trim() : "";

  if (!pid || !tok) {
    return {
      ok: false,
      code: "MISSING_FIELDS",
      message: "Phone Number ID and permanent access token are required.",
    };
  }

  let pn;
  try {
    const res = await axios.get(`${GRAPH}/${encodeURIComponent(pid)}`, {
      headers: { Authorization: `Bearer ${tok}` },
      params: { fields: "display_phone_number,verified_name,quality_rating,id" },
      timeout: 15000,
    });
    pn = res.data;
  } catch (e) {
    const meta = e.response?.data?.error;
    return {
      ok: false,
      code: "PHONE_LOOKUP_FAILED",
      message: meta?.message || e.message || "Meta rejected this Phone Number ID or token.",
      meta,
    };
  }

  if (!pn || !pn.display_phone_number) {
    return {
      ok: false,
      code: "BAD_PHONE_PAYLOAD",
      message: "Meta returned no display phone number — check the Phone Number ID.",
    };
  }

  if (waba) {
    try {
      const res = await axios.get(`${GRAPH}/${encodeURIComponent(waba)}/phone_numbers`, {
        headers: { Authorization: `Bearer ${tok}` },
        params: { fields: "id,display_phone_number,verified_name" },
        timeout: 15000,
      });
      const rows = Array.isArray(res.data?.data) ? res.data.data : [];
      const ids = rows.map((r) => String(r.id || "").trim()).filter(Boolean);
      if (!ids.includes(pid)) {
        return {
          ok: false,
          code: "WABA_MISMATCH",
          message:
            "This Phone Number ID is not on the WABA you entered. In Meta Business Suite → WhatsApp → API setup, copy the WABA ID and Phone number ID from the same asset.",
          display_phone_number: pn.display_phone_number,
          verified_name: pn.verified_name,
          wabaPhoneIdsSample: ids.slice(0, 8),
        };
      }
    } catch (e) {
      const meta = e.response?.data?.error;
      return {
        ok: false,
        code: "WABA_LOOKUP_FAILED",
        message:
          meta?.message ||
          "Could not list phone numbers for this WABA. Ensure the token includes whatsapp_business_management and whatsapp_business_messaging.",
        meta,
      };
    }
  }

  return {
    ok: true,
    display_phone_number: pn.display_phone_number,
    verified_name: pn.verified_name || null,
    quality_rating: pn.quality_rating || null,
    id: pn.id || pid,
  };
}

module.exports = { validateWhatsAppCloudCredentials, GRAPH };
