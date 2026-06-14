'use strict';

const axios = require('axios');
const Client = require('../models/Client');
const { encrypt, decrypt } = require('../utils/core/encryption');

const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000;

function hasShiprocketApiCredentials(clientLean) {
  const li = clientLean?.logisticsIntegration || {};
  return !!(String(li.shiprocketApiEmail || '').trim() && li.shiprocketApiPasswordEnc);
}

async function loginAndCacheToken(clientId, email, password) {
  const res = await axios.post(
    `${BASE_URL}/auth/login`,
    { email: String(email).trim(), password: String(password) },
    { timeout: 15000 }
  );
  const token = res.data?.token;
  if (!token) {
    const msg = res.data?.message || res.data?.error || 'shiprocket_auth_failed';
    throw new Error(String(msg));
  }

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        'logisticsIntegration.shiprocketTokenEnc': encrypt(token),
        'logisticsIntegration.shiprocketTokenExpiresAt': expiresAt,
      },
    }
  );
  return token;
}

async function getBearerToken(clientId) {
  const client = await Client.findOne({ clientId })
    .select('logisticsIntegration')
    .lean();
  if (!client) throw new Error('client_not_found');

  const li = client.logisticsIntegration || {};
  const expiresAt = li.shiprocketTokenExpiresAt
    ? new Date(li.shiprocketTokenExpiresAt).getTime()
    : 0;
  if (li.shiprocketTokenEnc && expiresAt > Date.now() + 3600000) {
    return decrypt(li.shiprocketTokenEnc);
  }

  const email = String(li.shiprocketApiEmail || '').trim();
  const passwordEnc = li.shiprocketApiPasswordEnc;
  if (!email || !passwordEnc) throw new Error('shiprocket_api_credentials_missing');

  return loginAndCacheToken(clientId, email, decrypt(passwordEnc));
}

/**
 * Push NDR reattempt / updated contact to Shiprocket.
 * @see https://apidocs.shiprocket.in/ — POST /v1/external/ndr/reattempt
 */
async function ndrReattempt({
  clientId,
  awb,
  phone,
  address1,
  address2,
  deferredDate,
}) {
  const cleanAwb = String(awb || '').trim();
  if (!cleanAwb) throw new Error('awb_required');

  const token = await getBearerToken(clientId);
  const params = { awb: cleanAwb };

  if (phone) {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length >= 10) params.phone = digits.slice(-10);
  }
  if (address1) params.address1 = String(address1).substring(0, 200);
  if (address2) params.address2 = String(address2).substring(0, 200);
  if (deferredDate) params.deferred_date = deferredDate;

  const res = await axios.post(`${BASE_URL}/ndr/reattempt`, null, {
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
  return res.data;
}

module.exports = {
  BASE_URL,
  hasShiprocketApiCredentials,
  getBearerToken,
  ndrReattempt,
  loginAndCacheToken,
};
