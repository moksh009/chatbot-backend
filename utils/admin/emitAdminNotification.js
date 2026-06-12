'use strict';

function emitAdminNotification(doc = {}) {
  try {
    const io = global.io;
    if (!io) return;
    io.to('super_admin_room').emit('admin_notification', {
      id: doc._id,
      title: doc.title,
      message: doc.message,
      type: doc.type || 'system',
      createdAt: doc.createdAt || new Date(),
    });
  } catch {
    /* non-fatal */
  }
}

module.exports = { emitAdminNotification };
