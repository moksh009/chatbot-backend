'use strict';

const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const log = require('./logger')('SocketAuth');
const { auditSecurity } = require('../../middleware/securityAudit');

const ADMIN_PSEUDO_CLIENT_ID = 'TOPEDGE_ADMIN';

/**
 * Resolve the tenant room a socket may subscribe to after JWT verification.
 * Super-admins may pass handshake.auth.clientId when impersonating a merchant.
 */
function resolveSocketTenantClientId(user, handshakeAuth = {}) {
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') {
    const impersonated = handshakeAuth.clientId && String(handshakeAuth.clientId).trim();
    if (impersonated && impersonated !== ADMIN_PSEUDO_CLIENT_ID) {
      return impersonated;
    }
    return null;
  }
  return user.clientId || null;
}

/**
 * Whether a socket may join client_${clientId}.
 */
function canJoinClientRoom(user, roomClientId, handshakeAuth = {}) {
  if (!user || !roomClientId) return false;
  const room = String(roomClientId).trim();
  if (!room) return false;

  if (user.role === 'SUPER_ADMIN') {
    if (room === ADMIN_PSEUDO_CLIENT_ID) return true;
    // Super-admins may join any merchant room (mirrors API tenant bypass for support).
    const impersonated = handshakeAuth.clientId && String(handshakeAuth.clientId).trim();
    if (impersonated && impersonated !== room && impersonated !== ADMIN_PSEUDO_CLIENT_ID) {
      log.info('Super-admin joined room outside handshake impersonation', {
        impersonated,
        room,
        userId: user._id,
      });
    }
    return true;
  }

  return String(user.clientId) === room;
}

function canJoinSuperAdminRoom(user) {
  return user?.role === 'SUPER_ADMIN';
}

function canJoinAgentRoom(user, agentId) {
  if (!user || !agentId) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  const uid = String(user._id || user.id || '');
  return uid && uid === String(agentId);
}

/**
 * Verify JWT from Socket.IO handshake (auth.token). Returns lean user doc.
 */
async function verifySocketUser(token) {
  if (!token || typeof token !== 'string') {
    const err = new Error('Authentication required');
    err.data = { code: 'SOCKET_AUTH_REQUIRED' };
    throw err;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    const err = new Error('Server configuration error');
    err.data = { code: 'SOCKET_AUTH_CONFIG' };
    throw err;
  }

  const decoded = jwt.verify(token, jwtSecret);

  if (decoded.type === 'admin_team' && decoded.adminMemberId) {
    const AdminTeamMember = require('../../models/AdminTeamMember');
    const member = await AdminTeamMember.findById(decoded.adminMemberId).lean();
    if (!member || !member.isActive) {
      const err = new Error('Admin account inactive');
      err.data = { code: 'SOCKET_AUTH_INACTIVE' };
      throw err;
    }
    return {
      _id: member._id,
      id: String(member._id),
      email: member.email,
      name: member.name,
      role: 'ADMIN_TEAM',
      isAdminTeam: true,
      clientId: null,
    };
  }

  const user = await User.findById(decoded.id).select('-password').lean();
  if (!user) {
    const err = new Error('User not found');
    err.data = { code: 'SOCKET_AUTH_USER' };
    throw err;
  }
  return user;
}

/**
 * Socket.IO middleware — attach socket.data.user and join authorized rooms on connect.
 */
function attachSocketAuthMiddleware(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const user = await verifySocketUser(token);
      socket.data.user = user;
      socket.data.handshakeAuth = socket.handshake.auth || {};
      next();
    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        log.warn('Socket JWT rejected', { reason: err.name, socketId: socket.id });
        return next(new Error('Authentication failed'));
      }
      log.warn('Socket auth failed', { message: err.message, socketId: socket.id });
      return next(new Error(err.message || 'Authentication failed'));
    }
  });
}

/**
 * Leave stale client_* rooms before joining a new tenant room (impersonation switch).
 */
function leaveStaleClientRooms(socket, keepClientIds = []) {
  const keep = new Set(
    keepClientIds.filter(Boolean).map((id) => `client_${String(id).trim()}`)
  );
  for (const room of socket.rooms) {
    if (room.startsWith('client_') && !keep.has(room)) {
      socket.leave(room);
    }
  }
}

function joinClientRoomSafely(socket, user, roomClientId, handshakeAuth = {}) {
  if (!canJoinClientRoom(user, roomClientId, handshakeAuth)) return false;

  const keepIds = [roomClientId];
  if (user.role === 'SUPER_ADMIN') {
    keepIds.push(ADMIN_PSEUDO_CLIENT_ID);
  }
  leaveStaleClientRooms(socket, keepIds);
  socket.join(`client_${roomClientId}`);
  return true;
}

function joinAuthorizedRooms(socket) {
  const user = socket.data.user;
  if (!user) return;

  const handshakeAuth = socket.data.handshakeAuth || {};
  const tenantClientId = resolveSocketTenantClientId(user, handshakeAuth);

  const keepClientIds = [];
  if (tenantClientId) keepClientIds.push(tenantClientId);
  if (user.role === 'SUPER_ADMIN') keepClientIds.push(ADMIN_PSEUDO_CLIENT_ID);

  leaveStaleClientRooms(socket, keepClientIds);

  if (tenantClientId) {
    socket.join(`client_${tenantClientId}`);
    log.info('Socket joined tenant room', { socketId: socket.id, clientId: tenantClientId });
  }

  if (user.role === 'SUPER_ADMIN') {
    socket.join('super_admin_room');
    socket.join(`client_${ADMIN_PSEUDO_CLIENT_ID}`);
    log.info('Socket joined super_admin_room', { socketId: socket.id });
  }

  const agentId = user._id || user.id;
  if (agentId) {
    socket.join(`agent_${agentId}`);
  }
}

function registerSocketRoomHandlers(socket) {
  const user = socket.data.user;
  const handshakeAuth = socket.data.handshakeAuth || {};

  socket.on('join_client_room', ({ clientId: roomClientId } = {}) => {
    if (!joinClientRoomSafely(socket, user, roomClientId, handshakeAuth)) {
      auditSecurity('SOCKET_ROOM_DENIED', {
        userId: user?._id,
        tenantId: user?.clientId,
        targetClientId: roomClientId,
        reason: 'join_client_room rejected',
      });
      log.warn('join_client_room denied', { socketId: socket.id, roomClientId, userId: user?._id });
      return;
    }
    log.info('Socket dynamically joined client room', { socketId: socket.id, clientId: roomClientId });
  });

  socket.on('join_super_admin', () => {
    if (!canJoinSuperAdminRoom(user)) {
      log.warn('join_super_admin denied', { socketId: socket.id, userId: user?._id });
      return;
    }
    socket.join('super_admin_room');
    log.info('Socket joined super_admin_room via event', { socketId: socket.id });
  });

  socket.on('join_agent', (agentId) => {
    if (!canJoinAgentRoom(user, agentId)) {
      log.warn('join_agent denied', { socketId: socket.id, agentId, userId: user?._id });
      return;
    }
    socket.join(`agent_${agentId}`);
    log.info('Socket joined agent room', { socketId: socket.id, agentId });
  });

  // Legacy alias — same guard as join_client_room
  socket.on('join_client', (cid) => {
    if (!joinClientRoomSafely(socket, user, cid, handshakeAuth)) {
      log.warn('join_client denied', { socketId: socket.id, clientId: cid });
      return;
    }
    log.info('Socket joined client room (legacy)', { socketId: socket.id, clientId: cid });
  });
}

module.exports = {
  ADMIN_PSEUDO_CLIENT_ID,
  attachSocketAuthMiddleware,
  joinAuthorizedRooms,
  registerSocketRoomHandlers,
  resolveSocketTenantClientId,
  canJoinClientRoom,
  canJoinSuperAdminRoom,
  canJoinAgentRoom,
  verifySocketUser,
  joinClientRoomSafely,
  leaveStaleClientRooms,
};
