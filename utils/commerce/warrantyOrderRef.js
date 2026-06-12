'use strict';

function stripHashOrderLabel(label = '') {
    const s = String(label || '').trim();
    const m = s.match(/^#(\d+)$/);
    return m ? m[1] : s;
}

function isNumericShopifyId(value) {
    return /^\d+$/.test(String(value || '').trim());
}

/**
 * Single canonical order ref for warranty records — numeric Shopify order id when available.
 * Never store display names like "#1035" when the numeric id exists.
 */
function canonicalWarrantyOrderId(input = {}) {
    if (typeof input === 'string' || typeof input === 'number') {
        const raw = String(input).trim();
        if (isNumericShopifyId(raw)) return raw;
        const stripped = stripHashOrderLabel(raw);
        return isNumericShopifyId(stripped) ? stripped : raw;
    }

    const payloadId = input.id != null ? String(input.id).trim() : '';
    if (isNumericShopifyId(payloadId)) return payloadId;

    const shopifyOrderId = String(input.shopifyOrderId || '').trim();
    if (isNumericShopifyId(shopifyOrderId)) return shopifyOrderId;

    for (const candidate of [input.orderId, input.name, input.orderNumber]) {
        const s = String(candidate || '').trim();
        if (!s) continue;
        if (isNumericShopifyId(s)) return s;
        const stripped = stripHashOrderLabel(s);
        if (isNumericShopifyId(stripped)) return stripped;
    }

    return shopifyOrderId || String(input.orderId || input.name || payloadId || '').trim();
}

/** All known aliases for one Shopify order (numeric id, #1035, orderId field, etc.). */
function orderRefAliases(input = {}) {
    const aliases = new Set();
    const add = (value) => {
        const s = String(value || '').trim();
        if (!s) return;
        aliases.add(s);
        const stripped = stripHashOrderLabel(s);
        if (stripped) aliases.add(stripped);
    };

    if (input.id != null) add(input.id);
    add(input.shopifyOrderId);
    add(input.orderId);
    add(input.name);
    add(input.orderNumber);
    if (input.order_number != null) add(`#${input.order_number}`);

    const canonical = canonicalWarrantyOrderId(input);
    if (canonical) aliases.add(canonical);

    return [...aliases];
}

function indexOrdersByAlias(orders = []) {
    const map = new Map();
    for (const order of orders) {
        for (const alias of orderRefAliases(order)) {
            if (!map.has(alias)) map.set(alias, order);
        }
    }
    return map;
}

function pickBestWarrantyRecord(a, b) {
    const score = (record) => {
        let s = 0;
        if (record.status === 'active') s += 1000;
        else if (record.status === 'expired') s += 500;
        const exp = record.expiryDate ? new Date(record.expiryDate).getTime() : 0;
        if (Number.isFinite(exp)) s += exp / 1e12;
        const created = record.createdAt ? new Date(record.createdAt).getTime() : 0;
        if (Number.isFinite(created)) s += created / 1e15;
        return s;
    };
    return score(a) >= score(b) ? a : b;
}

/** Collapse duplicate rows that refer to the same order+product under different id formats. */
function dedupeWarrantyRecords(records = [], orderIndex = new Map()) {
    const byKey = new Map();

    for (const record of records) {
        const linkedOrder = orderIndex.get(String(record.shopifyOrderId || '').trim()) || null;
        const canonical = linkedOrder
            ? canonicalWarrantyOrderId(linkedOrder)
            : canonicalWarrantyOrderId({ shopifyOrderId: record.shopifyOrderId });
        const productId = String(record.productId || record.productName || '').trim();
        const key = `${canonical}::${productId}`;
        const normalized = {
            ...record,
            shopifyOrderId: canonical,
            canonicalOrderId: canonical,
        };

        if (!byKey.has(key)) {
            byKey.set(key, normalized);
        } else {
            byKey.set(key, pickBestWarrantyRecord(byKey.get(key), normalized));
        }
    }

    return Array.from(byKey.values());
}

async function findExistingWarrantyRecord(WarrantyRecord, { clientId, orderInput, productId, productName }) {
    const aliases = orderRefAliases(orderInput);
    if (!aliases.length) return null;

    const pid = String(productId || '').trim();
    const pname = String(productName || '').trim();
    const orClauses = [{ clientId, shopifyOrderId: { $in: aliases }, productId: pid }];

    if (pname && pname !== pid) {
        orClauses.push({ clientId, shopifyOrderId: { $in: aliases }, productId: pname });
        orClauses.push({ clientId, shopifyOrderId: { $in: aliases }, productName: pname });
    }

    return WarrantyRecord.findOne({ $or: orClauses });
}

module.exports = {
    canonicalWarrantyOrderId,
    orderRefAliases,
    indexOrdersByAlias,
    dedupeWarrantyRecords,
    pickBestWarrantyRecord,
    findExistingWarrantyRecord,
};
