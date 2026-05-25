const AuditLog = require('../models/AuditLog');

exports.logAction = (action_type) => {
  return async (req, res, next) => {
    try {
      if (req.user && req.user._id) {
        // Fire & forget logging
        AuditLog.create({
          clientId: req.user.clientId,
          user_id: req.user._id,
          actor: {
            type: req.user.role === 'SUPER_ADMIN' ? 'super_admin' : 'user',
            userId: req.user._id,
            source: 'dashboard',
            ip: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
            userAgent: req.headers['user-agent'] || '',
          },
          action_type: action_type || 'SYSTEM_ACTION',
          target_resource: req.originalUrl,
          ip_address: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
          payload: req.method !== 'GET' ? req.body : req.query,
        }).catch((err) => console.error('Audit Log DB Error:', err));
      }
    } catch (e) {
      console.error('Audit Middleware Error:', e);
    }
    
    // Always move to next middleware without blocking
    next();
  };
};
