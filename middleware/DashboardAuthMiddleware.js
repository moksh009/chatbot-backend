const jwt = require('jsonwebtoken');

/**
 * DashboardAuthMiddleware
 * Secures Intent APIs to ensure only authenticated dashboard users can manage rules.
 */
exports.verifyDashboardToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    console.warn('[Security] Unauthorized access attempt: No token provided');
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error('[Security] JWT_SECRET is not defined in environment');
    return res.status(500).json({ success: false, message: 'Security misconfiguration' });
  }

  jwt.verify(token, jwtSecret, (err, decoded) => {
    if (err) {
      console.error('[Security] Token verification failed:', err.message);
      return res.status(403).json({ success: false, message: 'Invalid or expired session' });
    }
    
    /**
     * Attach the decoded context to the request.
     * req.user.clientId is critical for ensuring multi-tenant data isolation.
     */
    req.user = {
      userId: decoded.id,
      clientId: decoded.clientId,
      role: decoded.role || 'USER'
    };

    next();
  });
};
