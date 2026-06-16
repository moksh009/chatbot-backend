"use strict";

const axios = require("axios");

const GRAPH = "https://graph.facebook.com/v21.0";

function normalizeMetaId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^["']|["']$/g, "");
}

async function fetchPhoneMeta(phoneNumberId, token) {
  const res = await axios.get(`${GRAPH}/${encodeURIComponent(phoneNumberId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { fields: "display_phone_number,verified_name,quality_rating,id" },
    timeout: 15000,
    validateStatus: (s) => s < 500,
  });
  if (res.status >= 400 || !res.data?.display_phone_number) {
    return { ok: false, meta: res.data?.error || null };
  }
  return { ok: true, data: res.data };
}

async function listWabaPhoneNumbers(wabaId, token) {
  const res = await axios.get(`${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { fields: "id,display_phone_number,verified_name,quality_rating" },
    timeout: 15000,
    validateStatus: (s) => s < 500,
  });
  if (res.status >= 400) {
    return { ok: false, meta: res.data?.error || null, rows: [] };
  }
  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  return { ok: true, rows, meta: null };
}

function formatPhoneChoices(rows) {
  return rows
    .map((r) => `${r.display_phone_number || "number"} (ID ${r.id})`)
    .join("; ");
}

function credentialHelpMessage(meta, context = {}) {
  const msg = String(meta?.message || "");
  const code = meta?.code;

  if (code === 190 || msg.includes("Error validating access token")) {
    return "Access token expired or invalid. Generate a new permanent system-user token with whatsapp_business_messaging and whatsapp_business_management.";
  }

  if (
    msg.includes("Unsupported get request") ||
    msg.includes("does not exist") ||
    msg.includes("missing permissions")
  ) {
    if (context.triedAsPhone && context.wabaListed) {
      return `Meta rejected Phone number ID "${context.triedAsPhone}". That value looks like a WABA (account) ID, not a phone number. Use Phone number ID ${context.suggestedPhoneId || "from API setup"} instead — listed on the same Meta screen under your connected number.`;
    }
    if (context.availablePhones?.length) {
      return `Phone number ID not found on this WABA. Pick the correct ID from Meta → WhatsApp → API setup: ${formatPhoneChoices(context.availablePhones)}`;
    }
    return "Meta could not load this Phone number ID. Double-check you copied Phone number ID (under your number) — not WABA ID or App ID — and that the token has whatsapp_business_messaging + whatsapp_business_management on this WABA.";
  }

  return msg || "Meta rejected this Phone Number ID or token.";
}

/**
 * Validates WhatsApp Cloud API credentials against Meta Graph.
 * Auto-corrects common mistakes (WABA ID pasted in Phone number ID field, swapped fields).
 */
async function validateWhatsAppCloudCredentials({ phoneNumberId, whatsappToken, wabaId }) {
  const pid = normalizeMetaId(phoneNumberId);
  const tok = String(whatsappToken || "").trim();
  let waba = normalizeMetaId(wabaId);

  if (!pid || !tok) {
    return {
      ok: false,
      code: "MISSING_FIELDS",
      message: "Phone Number ID and permanent access token are required.",
    };
  }

  let resolvedPid = pid;
  let resolvedWaba = waba;
  let autoCorrected = null;
  let phoneMeta = null;

  const direct = await fetchPhoneMeta(pid, tok);
  if (direct.ok) {
    phoneMeta = direct.data;
  } else {
    const asWaba = await listWabaPhoneNumbers(pid, tok);
    if (asWaba.ok && asWaba.rows.length > 0) {
      if (asWaba.rows.length === 1) {
        resolvedPid = String(asWaba.rows[0].id);
        resolvedWaba = pid;
        phoneMeta = asWaba.rows[0];
        autoCorrected = "WABA_IN_PHONE_FIELD";
      } else {
        return {
          ok: false,
          code: "WABA_IN_PHONE_FIELD",
          message: `The ID "${pid}" is your WhatsApp Business Account (WABA), not a phone number. Enter one of these Phone number IDs: ${formatPhoneChoices(asWaba.rows)}`,
          availablePhoneNumbers: asWaba.rows,
          wabaId: pid,
        };
      }
    }
  }

  if (!phoneMeta && waba) {
    const wabaPhones = await listWabaPhoneNumbers(waba, tok);
    if (wabaPhones.ok && wabaPhones.rows.length > 0) {
      const match = wabaPhones.rows.find((r) => String(r.id) === pid);
      if (match) {
        phoneMeta = match;
      } else {
        const wabaAsPhone = await fetchPhoneMeta(waba, tok);
        if (wabaAsPhone.ok) {
          resolvedPid = waba;
          resolvedWaba = pid;
          phoneMeta = wabaAsPhone.data;
          autoCorrected = "SWAPPED_PHONE_AND_WABA";
        } else if (wabaPhones.rows.length === 1) {
          resolvedPid = String(wabaPhones.rows[0].id);
          phoneMeta = wabaPhones.rows[0];
          autoCorrected = "PHONE_ID_AUTO_SELECTED";
        } else {
          return {
            ok: false,
            code: "WABA_MISMATCH",
            message: `Phone number ID "${pid}" is not on WABA "${waba}". Available numbers: ${formatPhoneChoices(wabaPhones.rows)}`,
            availablePhoneNumbers: wabaPhones.rows,
            wabaPhoneIdsSample: wabaPhones.rows.map((r) => r.id).slice(0, 8),
          };
        }
      }
    } else if (!phoneMeta) {
      const wabaAsPhone = await fetchPhoneMeta(waba, tok);
      if (wabaAsPhone.ok) {
        resolvedPid = waba;
        resolvedWaba = pid;
        phoneMeta = wabaAsPhone.data;
        autoCorrected = "SWAPPED_PHONE_AND_WABA";
      }
    }
  }

  if (!phoneMeta && !waba) {
    const asWabaOnly = await listWabaPhoneNumbers(pid, tok);
    if (asWabaOnly.ok && asWabaOnly.rows.length === 1) {
      resolvedPid = String(asWabaOnly.rows[0].id);
      resolvedWaba = pid;
      phoneMeta = asWabaOnly.rows[0];
      autoCorrected = "WABA_IN_PHONE_FIELD";
    }
  }

  if (!phoneMeta) {
    let availablePhones = [];
    let fallbackMeta = direct.meta;
    if (waba) {
      const listed = await listWabaPhoneNumbers(waba, tok);
      if (listed.ok) availablePhones = listed.rows;
      else if (listed.meta) fallbackMeta = listed.meta;
    }
    if (!availablePhones.length) {
      const asWaba = await listWabaPhoneNumbers(pid, tok);
      if (asWaba.ok) availablePhones = asWaba.rows;
      else if (asWaba.meta) fallbackMeta = asWaba.meta;
    }
    return {
      ok: false,
      code: "PHONE_LOOKUP_FAILED",
      message: credentialHelpMessage(fallbackMeta, {
        triedAsPhone: pid,
        wabaListed: Boolean(availablePhones.length),
        suggestedPhoneId: availablePhones[0]?.id,
        availablePhones,
      }),
      meta: fallbackMeta,
    };
  }

  if (!resolvedWaba && autoCorrected === "WABA_IN_PHONE_FIELD") {
    resolvedWaba = waba || pid;
  }

  if (resolvedWaba) {
    const wabaPhones = await listWabaPhoneNumbers(resolvedWaba, tok);
    if (wabaPhones.ok) {
      const ids = wabaPhones.rows.map((r) => String(r.id || "").trim()).filter(Boolean);
      if (ids.length && !ids.includes(resolvedPid)) {
        if (wabaPhones.rows.length === 1) {
          resolvedPid = ids[0];
          phoneMeta = wabaPhones.rows[0];
          autoCorrected = autoCorrected || "PHONE_ID_AUTO_SELECTED";
        } else {
          return {
            ok: false,
            code: "WABA_MISMATCH",
            message: `Phone number ID "${resolvedPid}" is not on WABA "${resolvedWaba}". Available: ${formatPhoneChoices(wabaPhones.rows)}`,
            display_phone_number: phoneMeta.display_phone_number,
            verified_name: phoneMeta.verified_name,
            wabaPhoneIdsSample: ids.slice(0, 8),
            availablePhoneNumbers: wabaPhones.rows,
          };
        }
      }
    } else if (wabaPhones.meta) {
      return {
        ok: false,
        code: "WABA_LOOKUP_FAILED",
        message: credentialHelpMessage(wabaPhones.meta, { triedAsPhone: resolvedPid }),
        meta: wabaPhones.meta,
      };
    }
  }

  return {
    ok: true,
    display_phone_number: phoneMeta.display_phone_number,
    verified_name: phoneMeta.verified_name || null,
    quality_rating: phoneMeta.quality_rating || null,
    id: phoneMeta.id || resolvedPid,
    phoneNumberId: resolvedPid,
    wabaId: resolvedWaba || waba || null,
    autoCorrected,
  };
}

module.exports = {
  validateWhatsAppCloudCredentials,
  normalizeMetaId,
  GRAPH,
};
