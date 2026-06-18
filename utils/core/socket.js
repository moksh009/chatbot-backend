const socketIo = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const log = require('./logger')('Socket');
const { getAppRedis, getQueueRedis } = require('./redisFactory');
const {
  attachSocketAuthMiddleware,
  joinAuthorizedRooms,
  registerSocketRoomHandlers,
} = require('./socketAuth');

let io = null;

/**
 * Initializes Socket.io with the given HTTP server.
 * Uses shared Redis singleton(s) + duplicate subscriber — avoids extra TCP connections.
 * All connections require JWT via handshake.auth.token (see socketAuth.js).
 */
const init = (server) => {
  const dashOrigins = [
    process.env.FRONTEND_URL,
    'https://dash.topedgeai.com',
    'https://www.dash.topedgeai.com',
    'https://topedgeai.com',
    'https://www.topedgeai.com',
    'http://localhost:5173',
    'https://localhost:5173',
    'http://localhost:3000',
    'https://localhost:3000',
  ].filter(Boolean);

  const ioOptions = {
    cors: {
      origin: dashOrigins.length ? dashOrigins : '*',
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

  attachSocketAuthMiddleware(io);

  io.on('connection', (socket) => {
    const userId = socket.data.user?._id || socket.data.user?.id;
    log.info('Client connected', { socketId: socket.id, userId, role: socket.data.user?.role });

    joinAuthorizedRooms(socket);
    registerSocketRoomHandlers(socket);

    socket.on('disconnect', () => {
      log.info('Client disconnected', { socketId: socket.id, userId });
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
