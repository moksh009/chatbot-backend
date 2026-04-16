const ActivityLog = require('../models/ActivityLog');
const log = require('./logger')('ActivityLogger');

/**
 * Enterprise Activity Logger
 * Centralizes system-wide events and broadcasts them in real-time.
 * 
 * @param {string} clientId - The ID of the client.
 * @param {object} params - { type, status, title, message, icon, url, metadata }
 */
const logActivity = async (clientId, { type, status = 'info', title, message, icon, url, metadata }) => {
    try {
        if (!clientId) {
            log.warn('Attempted to log activity without clientId', { title });
            return;
        }

        // 1. Persist to Database
        const activity = await ActivityLog.create({
            clientId,
            type,
            status,
            title,
            message,
            icon,
            url,
            metadata,
            createdAt: new Date()
        });

        // 2. Broadcast via Socket.io
        if (global.io) {
            // Emit to the specific client room
            global.io.to(`client_${clientId}`).emit('pulse_event', activity);

            // If it's a critical event, we also emit a special event that can trigger rich toasts
            const isCritical = metadata?.isCritical || status === 'error' || (type === 'ORDER' && metadata?.amount > 1000);
            if (isCritical) {
                global.io.to(`client_${clientId}`).emit('critical_pulse_event', {
                    ...activity.toObject(),
                    toastDescription: message || title
                });
            }
        }

        return activity;
    } catch (err) {
        log.error('Failed to log activity', { error: err.message, title });
    }
};

module.exports = { logActivity, logPulse: logActivity };
