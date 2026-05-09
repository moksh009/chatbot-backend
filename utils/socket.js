const socketIo = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const log = require('./logger')('Socket');
const { getAppRedis, getQueueRedis } = require('./redisFactory');

let io = null;

/**
 * Initializes Socket.io with the given HTTP server.
 * Uses shared Redis singleton(s) + duplicate subscriber — avoids extra TCP connections.
 */
const init = (server) => {
  const ioOptions = {
    cors: {
      origin: process.env.FRONTEND_URL || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  };

  io = socketIo(server, ioOptions);

  const pubClient = getAppRedis() || getQueueRedis();
  const shouldAttachRedis = !!(process.env.REDIS_URL && pubClient);

  if (shouldAttachRedis) {
    try {
      const subClient = pubClient.duplicate();
      io.adapter(createAdapter(pubClient, subClient));
      global.redisClient = pubClient;
      global.redisConnected = true;
      log.info('Socket.io Redis Adapter attached (shared Redis client).');
    } catch (err) {
      log.error('Failed to initialize Redis Adapter:', err.message);
    }
  } else if (!process.env.REDIS_URL) {
    log.warn('⚠️ REDIS_URL not set — Socket.io running without Redis adapter (single instance only).');
  }

  global.io = io;

  io.on('connection', (socket) => {
    log.info('New client connected', { socketId: socket.id });

    const clientId = socket.handshake.query.clientId;
    if (clientId) {
      socket.join(`client_${clientId}`);
      log.info(`Socket joined client room`, { socketId: socket.id, clientId });
    }

    const userRole = socket.handshake.query.role;
    if (userRole === 'SUPER_ADMIN') {
      socket.join('super_admin_room');
      log.info(`Socket joined super_admin_room`, { socketId: socket.id });
    }

    socket.on('join_agent', (agentId) => {
      socket.join(`agent_${agentId}`);
      log.info(`Socket joined agent room`, { socketId: socket.id, agentId });
    });

    socket.on('join_client_room', ({ clientId: roomClientId } = {}) => {
      if (roomClientId) {
        socket.join(`client_${roomClientId}`);
        log.info(`Socket dynamically joined client room`, { socketId: socket.id, clientId: roomClientId });
      }
    });

    socket.on('join_client', (cid) => {
      if (cid) {
        socket.join(`client_${cid}`);
        log.info(`Socket joined client_${cid}`);
      }
    });

    socket.on('disconnect', () => {
      log.info('Client disconnected', { socketId: socket.id });
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized! Call init(server) first.');
  }
  return io;
};

const emitToClient = (clientId, event, data) => {
  if (!io) {
    log.warn(`Cannot emit ${event} - IO not initialized.`);
    return;
  }
  io.to(`client_${clientId}`).emit(event, data);
};

module.exports = {
  init,
  getIO,
  emitToClient
};
