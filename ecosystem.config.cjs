/**
 * PM2 split deploy — same host (Contabo): API + worker with per-process RUN_* env.
 * Shared secrets stay in .env (loaded by index.js via dotenv).
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart ecosystem.config.cjs --update-env
 */
const path = require('path');

const root = __dirname;

const shared = {
  NODE_ENV: 'production',
  SUPPRESS_SPLIT_DEPLOY_WARN: 'true',
};

module.exports = {
  apps: [
    {
      name: 'topedge-api',
      cwd: root,
      script: 'index.js',
      env_file: path.join(root, '.env'),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 15,
      min_uptime: '8s',
      listen_timeout: 20000,
      env: {
        ...shared,
        RUN_API: 'true',
        RUN_CRONS: 'false',
        RUN_WORKERS: 'false',
        CHATBOT_PROCESS_ROLE: 'api',
        EMAIL_SCHEDULE_TICK_ON_API: 'true',
        ABANDON_CART_TICK_ON_API: 'false',
        DEFER_STARTUP_HEAVY_MS: '45000',
        MONGODB_MAX_POOL_SIZE: '25',
      },
    },
    {
      name: 'topedge-worker',
      cwd: root,
      script: 'index.js',
      env_file: path.join(root, '.env'),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 15,
      min_uptime: '8s',
      env: {
        ...shared,
        RUN_API: 'false',
        RUN_CRONS: 'true',
        RUN_WORKERS: 'true',
        CHATBOT_PROCESS_ROLE: 'worker',
        EMAIL_SCHEDULE_TICK_ON_API: 'false',
        ABANDON_CART_TICK_ON_API: 'false',
        CRON_USE_COORDINATOR: 'true',
        CRON_MONGO_CONCURRENCY: '3',
        CRON_MONGO_BUDGET: 'true',
        ENABLE_SELF_PING: 'false',
        MONGODB_MAX_POOL_SIZE: '15',
      },
    },
  ],
};
