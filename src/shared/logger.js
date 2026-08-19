// search.logger.js
const pino = require('pino');
const path = require('path');

const targets = [
  // 1. Write all error logs to errors.log
  {
    target: 'pino/file',
    level: 'error',
    options: { destination: path.join(__dirname, 'logs', 'errors.log'), mkdir: true }
  },
  // 2. Write all activity logs (info and above) to activity.log
  {
    target: 'pino/file',
    level: 'info',
    options: { destination: path.join(__dirname, 'logs', 'activity.log'), mkdir: true }
  }
];

// 3. If we are in development, also log to the console with colors and pretty formatting
if (process.env.NODE_ENV !== 'production') {
  targets.push({
    target: 'pino-pretty',
    level: 'info',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname' // Hides cluttering process IDs from local console
    }
  });
}

const logger = pino({
  level: 'info', // Minimum global log level
  timestamp: pino.stdTimeFunctions.isoTime
}, pino.transport({ targets }));

module.exports = logger;