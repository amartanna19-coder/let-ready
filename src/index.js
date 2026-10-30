'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const compliance = require('./compliance');
const { openDatabase } = require('./db');
const { createTransport } = require('./mailer');
const { runJobs } = require('./jobs');
const { createServer } = require('./server');

const SHUTDOWN_TIMEOUT_MS = 10000;

function main() {
  const config = loadConfig();
  const dataDir = path.resolve(config.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const db = openDatabase(path.join(dataDir, 'letready.db'));
  const transport = createTransport(config.mail);
  const server = createServer({ db, config });

  const tick = () => {
    runJobs({
      db,
      transport,
      appUrl: config.appUrl,
      today: compliance.todayInLondon(),
      now: Date.now(),
    })
      .then((result) => {
        if (result.reminders_queued || result.outbox.sent || result.outbox.failed) {
          console.log('Background job:', JSON.stringify(result));
        }
      })
      .catch((error) => console.error('Background job failed:', error));
  };

  const timer = setInterval(tick, config.reminderIntervalMinutes * 60 * 1000);
  timer.unref();
  tick();

  server.listen(config.port, () => {
    console.log(`Let Ready is running at ${config.appUrl}`);
    if (!transport) console.log('Email sending is off (MAIL_PROVIDER is not set). Reminders are not queued.');
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down.`);
    clearInterval(timer);
    const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
