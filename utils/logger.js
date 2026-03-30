/**
 * Structured Logger Utility
 * Usage: const log = require('./utils/logger')('ServiceName');
 *        log.info('Message', { optional data });
 *        log.warn('...'), log.error('...'), log.debug('...')
 */

const COLORS = {
  reset: '\x1b[0m',
  info:  '\x1b[36m',  // Cyan
  warn:  '\x1b[33m',  // Yellow
  error: '\x1b[31m',  // Red
  debug: '\x1b[90m',  // Gray
  success: '\x1b[32m' // Green
};

function formatMsg(level, service, message, data) {
  const ts = new Date().toISOString();
  const colorCode = COLORS[level] || COLORS.reset;
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  return `${colorCode}[${ts}] [${level.toUpperCase()}] [${service}] ${message}${dataStr}${COLORS.reset}`;
}

function createLogger(service) {
  return {
    info:    (msg, data) => console.log(formatMsg('info', service, msg, data)),
    warn:    (msg, data) => console.warn(formatMsg('warn', service, msg, data)),
    error:   (msg, data) => console.error(formatMsg('error', service, msg, data)),
    debug:   (msg, data) => {
      if (process.env.DEBUG_LOGS === 'true') {
        console.log(formatMsg('debug', service, msg, data));
      }
    },
    success: (msg, data) => console.log(formatMsg('success', service, msg, data))
  };
}

module.exports = createLogger;
