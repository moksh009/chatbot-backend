'use strict';

/**
 * Map aggregator webhook payloads → Shopify-shaped shipment_status values.
 */

function normalizeLabel(label) {
  return String(label || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function mapLabelToStatus(label) {
  const l = normalizeLabel(label);
  if (!l) return '';
  if (l.includes('OUT FOR DELIVERY') || l === 'OFD') return 'out_for_delivery';
  if (l.includes('DELIVERED') && !l.includes('UNDELIVERED')) return 'delivered';
  if (l.includes('UNDELIVERED') || l.includes('NDR') || l.includes('NOT DELIVERED')) {
    return 'attempted_delivery';
  }
  if (l.includes('RTO') || l.includes('RETURN')) return 'failure';
  if (l.includes('IN TRANSIT') || l.includes('TRANSIT') || l.includes('SHIPPED')) return 'in_transit';
  if (l.includes('PICKED') || l.includes('DISPATCH')) return 'in_transit';
  return '';
}

function extractFromShiprocket(body = {}) {
  const root = body.shipment || body.order || body;
  const track = body.tracking_data || root.tracking_data || {};
  const rows = Array.isArray(track.shipment_track)
    ? track.shipment_track
    : Array.isArray(track.shipment_track_activities)
      ? track.shipment_track_activities
      : [];

  let status = '';
  if (rows.length) {
    const latest = rows[rows.length - 1];
    status =
      mapLabelToStatus(latest['sr-status-label']) ||
      mapLabelToStatus(latest.activity) ||
      mapLabelToStatus(latest.status);
  }

  if (!status) {
    status =
      mapLabelToStatus(body.current_status) ||
      mapLabelToStatus(body.status) ||
      mapLabelToStatus(root.current_status) ||
      mapLabelToStatus(root.status);
  }

  const orderId =
    root.channel_order_id ||
    root.order_id ||
    body.order_id ||
    root.orderid ||
    '';

  const trackingNumber =
    root.awb ||
    root.awb_code ||
    track.awb ||
    body.awb ||
    root.tracking_number ||
    '';

  const trackingUrl =
    track.track_url ||
    root.track_url ||
    root.tracking_url ||
    '';

  return {
    shipmentStatus: status,
    orderId: String(orderId || '').trim(),
    trackingNumber: String(trackingNumber || '').trim(),
    trackingUrl: String(trackingUrl || '').trim(),
    rawProvider: 'shiprocket',
  };
}

function extractFromGeneric(body = {}) {
  const statusRaw = body.shipment_status || body.status || body.current_status || '';
  const status = String(statusRaw).toLowerCase().trim() || mapLabelToStatus(statusRaw);
  return {
    shipmentStatus: status,
    orderId: String(body.order_id || body.channel_order_id || '').trim(),
    trackingNumber: String(body.tracking_number || body.awb || '').trim(),
    trackingUrl: String(body.tracking_url || '').trim(),
    rawProvider: 'generic',
  };
}

function normalizeInboundPayload(provider, body) {
  const p = String(provider || '').toLowerCase();
  if (p === 'sr' || p === 'shiprocket') return extractFromShiprocket(body);
  return extractFromGeneric(body);
}

module.exports = {
  mapLabelToStatus,
  normalizeInboundPayload,
  extractFromShiprocket,
};
