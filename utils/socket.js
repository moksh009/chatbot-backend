const socketIo = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const log = require('./logger')('Socket');

let io = null;

/**
 * Initializes Socket.io with the given HTTP server.
 * Handles Redis adapter configuration for horizontal scaling.
 */
const init = (server) => {
  let ioOptions = {
    cors: {
      origin: process.env.FRONTEND_URL || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  };

  io = socketIo(server, ioOptions);

  if (process.env.REDIS_URL) {
    const isInternalRenderRedis = process.env.REDIS_URL.includes('red-');
    const isRunningOnRender = !!process.env.RENDER;

    // Skip Redis if running locally and trying to connect to internal Render Redis
    if (!(isInternalRenderRedis && !isRunningOnRender)) {
      try {
        const pubClient = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          retryStrategy: (times) => (times > 1 ? null : 1000)
        });

        pubClient.on('connect', () => {
          global.redisConnected = true;
          global.redisClient = pubClient;
          log.success('✅ Redis connected successfully.');
        });

        pubClient.on('error', (err) => {
          log.warn('⚠️ Redis Connection Error:', { message: err.message, code: err.code });
        });

        const subClient = pubClient.duplicate();
        io.adapter(createAdapter(pubClient, subClient));
        log.info('Socket.io Redis Adapter attached.');
      } catch (err) {
        log.error('Failed to initialize Redis Adapter:', err.message);
      }
    } else {
      log.warn('⚠️ Skipping Redis Adapter in local environment for Render-internal URL.');
    }
  }

  // Maintain backward compatibility with global.io
  global.io = io;

  io.on('connection', (socket) => {
    log.info('New client connected', { socketId: socket.id });

    // Join room based on clientId if provided in query
    const clientId = socket.handshake.query.clientId;
    if (clientId) {
      socket.join(`client_${clientId}`);
      log.info(`Socket joined client room`, { socketId: socket.id, clientId });
    }

    // Join Super Admin room if role is provided
    const userRole = socket.handshake.query.role;
    if (userRole === 'SUPER_ADMIN') {
      socket.join('super_admin_room');
      log.info(`Socket joined super_admin_room`, { socketId: socket.id });
    }

    socket.on('join_agent', (agentId) => {
      socket.join(`agent_${agentId}`);
      log.info(`Socket joined agent room`, { socketId: socket.id, agentId });
    });

    // Dynamic room join (e.g. SuperAdmin switching clients)
    socket.on('join_client_room', ({ clientId: roomClientId } = {}) => {
      if (roomClientId) {
        socket.join(`client_${roomClientId}`);
        log.info(`Socket dynamically joined client room`, { socketId: socket.id, clientId: roomClientId });
      }
    });

    // Legacy/Alias
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

/**
 * Returns the initialized Socket.io instance.
 */
const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized! Call init(server) first.');
  }
  return io;
};

/**
 * Emits an event to all sockets in a specific client room.
 * This is the preferred way to send real-time updates.
 */
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
