const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_dev');

      req.user = await User.findById(decoded.id).select('-password');
      if (!req.user) {
          return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      // Objective 1: Attach God Mode status
      const Client = require('../models/Client');
      const client = await Client.findOne({ clientId: req.user.clientId });
      req.user.isLifetimeAdmin = req.user.role === 'SUPER_ADMIN' || (client && client.isLifetimeAdmin);

      next();
    } catch (error) {
      console.error('[Auth Middleware] Error validating token or fetching user:', error);
      
      // If it's a genuine JWT error (expired, malformed, signature mismatch), it's a 401
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Not authorized, token failed' });
      }

      // If it's a MongoDB timeout or other server-side issue during cold start, return 500
      // so the frontend knows it's a transient server issue and can retry, rather than logging out.
      return res.status(500).json({ message: 'Server Error during authentication', error: error.message });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    // Master Tester Override: delitech2708@gmail.com gets past all role checks
    if (req.user?.email === 'delitech2708@gmail.com') {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `User role ${req.user.role} is not authorized to access this route`
      });
    }
    next();
  };
};

const verifyClientAccess = (req, res, next) => {
  const { clientId } = req.params;
  
  // Master Tester Override
  if (req.user?.email === 'delitech2708@gmail.com') {
    return next();
  }

  if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

module.exports = { protect, verifyToken: protect, authorize, verifyClientAccess };
