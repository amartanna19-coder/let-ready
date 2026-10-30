'use strict';

// Reads settings from environment variables. Defaults are safe for local use:
// no emails are sent unless MAIL_PROVIDER is set.
function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number.');

  const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(appUrl)) throw new Error('APP_URL must start with http:// or https://.');

  const provider = env.MAIL_PROVIDER || 'none';
  return {
    port,
    dataDir: env.DATA_DIR || 'data',
    appUrl,
    secureCookies: env.SECURE_COOKIES === '1' || appUrl.startsWith('https://'),
    trustProxy: env.TRUST_PROXY === '1',
    reminderIntervalMinutes: Number(env.REMINDER_INTERVAL_MINUTES || 60),
    mail: {
      provider,
      from: env.MAIL_FROM || '',
      apiKey: env.RESEND_API_KEY || '',
    },
  };
}

module.exports = { loadConfig };
