'use strict';

const { normalizePhone } = require('../core/helpers');

function phoneSuffixKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const suffix = d.length >= 10 ? d.slice(-10) : '';
  return suffix && suffix !== '0000000000' ? suffix : '';
}

function normalizeEmailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && e.includes('@') ? e : '';
}

function splitDisplayName(name) {
  const parts = String(name || 'Customer').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'Customer',
    last_name: parts.slice(1).join(' '),
  };
}

/**
 * Canonical warranty counts from WarrantyRecord + Contact (Audience Hub source of truth).
 */
async function loadWarrantySignalsByIdentity(clientId) {
  const WarrantyRecord = require('../../models/WarrantyRecord');
  const Contact = require('../../models/Contact');

  const records = await WarrantyRecord.find({ clientId }).select('customerId status').lean();
  const byContactId = new Map();
  const byPhone = new Map();
  const byEmail = new Map();

  if (!records.length) {
    return { byContactId, byPhone, byEmail };
  }

  const contactIds = [...new Set(records.map((r) => String(r.customerId)).filter(Boolean))];
  const contacts = await Contact.find({ clientId, _id: { $in: contactIds } })
    .select('phoneNumber email name')
    .lean();
  const contactById = new Map(contacts.map((c) => [String(c._id), c]));

  for (const record of records) {
    const contact = contactById.get(String(record.customerId));
    if (!contact) continue;

    const cid = String(contact._id);
    if (!byContactId.has(cid)) {
      byContactId.set(cid, {
        contactId: cid,
        name: contact.name || '',
        phone: normalizePhone(contact.phoneNumber),
        email: normalizeEmailKey(contact.email),
        total: 0,
        active: 0,
      });
    }
    const entry = byContactId.get(cid);
    entry.total += 1;
    if (record.status === 'active') entry.active += 1;
  }

  for (const entry of byContactId.values()) {
    const ps = phoneSuffixKey(entry.phone);
    if (ps) byPhone.set(ps, entry);
    if (entry.email) byEmail.set(entry.email, entry);
  }

  return { byContactId, byPhone, byEmail };
}

function resolveWarrantyForCustomer(customer, warrantyMaps) {
  const { byPhone, byEmail } = warrantyMaps;
  const phones = new Set();
  const emails = new Set();

  for (const ph of [
    customer?.phone,
    customer?.workspacePhone,
    ...(customer?.linkedPhones || []),
  ]) {
    const ps = phoneSuffixKey(ph);
    if (ps) phones.add(ps);
  }
  for (const em of [customer?.email, ...(customer?.linkedEmails || [])]) {
    const ek = normalizeEmailKey(em);
    if (ek) emails.add(ek);
  }

  let best = null;
  for (const ps of phones) {
    const hit = byPhone.get(ps);
    if (hit && (!best || hit.total > best.total)) best = hit;
  }
  for (const em of emails) {
    const hit = byEmail.get(em);
    if (hit && (!best || hit.total > best.total)) best = hit;
  }
  if (customer?.contactId && warrantyMaps.byContactId.has(String(customer.contactId))) {
    const hit = warrantyMaps.byContactId.get(String(customer.contactId));
    if (!best || hit.total > best.total) best = hit;
  }
  return best;
}

function collectCustomerIdentityKeys(customer) {
  const phones = new Set();
  const emails = new Set();
  const contactIds = new Set();

  if (customer?.contactId) contactIds.add(String(customer.contactId));
  for (const ph of [
    customer?.phone,
    customer?.workspacePhone,
    ...(customer?.linkedPhones || []),
  ]) {
    const ps = phoneSuffixKey(ph);
    if (ps) phones.add(ps);
  }
  for (const em of [customer?.email, ...(customer?.linkedEmails || [])]) {
    const ek = normalizeEmailKey(em);
    if (ek) emails.add(ek);
  }

  return { phones, emails, contactIds };
}

/**
 * Add warranty contacts that are not represented in the Shopify customer cache.
 */
function appendWorkspaceCustomers(customers, warrantyMaps) {
  const list = Array.isArray(customers) ? [...customers] : [];
  const covered = { phones: new Set(), emails: new Set(), contactIds: new Set() };

  for (const c of list) {
    const keys = collectCustomerIdentityKeys(c);
    keys.phones.forEach((p) => covered.phones.add(p));
    keys.emails.forEach((e) => covered.emails.add(e));
    keys.contactIds.forEach((id) => covered.contactIds.add(id));
  }

  const additions = [];
  for (const entry of warrantyMaps.byContactId.values()) {
    if (!entry.total) continue;
    const ps = phoneSuffixKey(entry.phone);
    const em = entry.email;
    const matched =
      covered.contactIds.has(entry.contactId) ||
      (ps && covered.phones.has(ps)) ||
      (em && covered.emails.has(em));
    if (matched) continue;

    const { first_name, last_name } = splitDisplayName(entry.name);
    additions.push({
      id: `contact:${entry.contactId}`,
      first_name,
      last_name,
      phone: entry.phone || null,
      email: entry.email || '',
      linkedPhones: entry.phone ? [entry.phone] : [],
      linkedEmails: entry.email ? [entry.email] : [],
      contactId: entry.contactId,
      leadName: entry.name || null,
      total_spent: '0',
      orders_count: 0,
      warrantyTotal: entry.total,
      warrantyActive: entry.active,
      warrantyEnabled: true,
      source: 'workspace_contact',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return [...list, ...additions];
}

module.exports = {
  phoneSuffixKey,
  normalizeEmailKey,
  splitDisplayName,
  loadWarrantySignalsByIdentity,
  resolveWarrantyForCustomer,
  appendWorkspaceCustomers,
  collectCustomerIdentityKeys,
};
