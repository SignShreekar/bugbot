module.exports = {
  apps: [
    {
      name: 'bugbot',
      script: 'src/index.js',
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
