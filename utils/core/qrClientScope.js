'use strict';

/** Match QR rows stored with string clientId or legacy ObjectId string. */
function qrClientIdFilter(client) {
  const ids = new Set();
  if (client?.clientId) ids.add(String(client.clientId));
  if (client?._id) ids.add(String(client._id));
  const list = [...ids];
  if (list.length <= 1) return { clientId: list[0] || '' };
  return { $or: list.map((id) => ({ clientId: id })) };
}

function qrBelongsToClient(qr, client) {
  if (!qr || !client) return false;
  const stored = String(qr.clientId || '');
  return stored === String(client.clientId) || stored === String(client._id);
}

function resolveClientWaPhone(client) {
  if (!client) return '';
  return (
    String(client.whatsappDisplayPhoneNumber || '').replace(/\D/g, '') ||
    String(client.phoneNumber || '').replace(/\D/g, '') ||
    String(client.adminPhone || '').replace(/\D/g, '') ||
    String(client?.platformVars?.adminWhatsappNumber || '').replace(/\D/g, '') ||
    String(client?.wabaAccounts?.[0]?.phoneNumber || '').replace(/\D/g, '')
  );
}

module.exports = { qrClientIdFilter, qrBelongsToClient, resolveClientWaPhone };
