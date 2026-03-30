const winston = require("winston");

/**
 * Structured Logger Utility using Winston
 * Usage: const log = require('./utils/logger')('ServiceName');
 *        log.info('Message', { optional data });
 */
const createLogger = (service) => {
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
            const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
            return `${timestamp} [${level}] [${service}] ${message}${metaStr}`;
          })
        ),
      }),
    ],
  });

  return {
    info: (msg, data) => logger.info(msg, data),
    warn: (msg, data) => logger.warn(msg, data),
    error: (msg, data) => logger.error(msg, data),
    debug: (msg, data) => logger.debug(msg, data),
    success: (msg, data) => logger.info(`✅ ${msg}`, data), // Winston doesn't have 'success', mapping to info
  };
};

module.exports = createLogger;

