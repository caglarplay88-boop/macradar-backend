const fs = require('fs');
const { pool } = require('./db');

const CHANNEL = 'dropping_settings_changed';
const TIMEOUT_MS = 3000;

(async () => {
  const storeSource = fs.readFileSync(
    require.resolve('./dropping-store'),
    'utf8'
  );
  const watcherSource = fs.readFileSync(
    require.resolve('./dropping-watcher'),
    'utf8'
  );

  if (!storeSource.includes("pg_notify('dropping_settings_changed'")) {
    throw new Error('store notify hook missing');
  }
  if (!watcherSource.includes('LISTEN dropping_settings_changed')) {
    throw new Error('watcher listen hook missing');
  }

  const listener = await pool.connect();
  try {
    let timer = null;
    const received = new Promise((resolve, reject) => {
      const onNotification = message => {
        if (message.channel !== CHANNEL) return;
        clearTimeout(timer);
        listener.removeListener('notification', onNotification);
        resolve(message.payload);
      };

      listener.on('notification', onNotification);
      timer = setTimeout(() => {
        listener.removeListener('notification', onNotification);
        reject(new Error('notification timeout'));
      }, TIMEOUT_MS);
    });

    await listener.query('LISTEN ' + CHANNEL);
    const started = Date.now();
    await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, 'test']);
    const payload = await received;
    const elapsed = Date.now() - started;

    if (payload !== 'test') {
      throw new Error('payload mismatch');
    }
    if (elapsed >= TIMEOUT_MS) {
      throw new Error('notification too slow');
    }

    console.log(
      'SETTINGS_WAKE_TEST=OK CHANNEL=' + CHANNEL +
      ' PAYLOAD=' + payload +
      ' ELAPSED_MS=' + elapsed
    );
  } finally {
    try { await listener.query('UNLISTEN ' + CHANNEL); } catch {}
    listener.release();
    await pool.end();
  }
})().catch(async error => {
  console.error('SETTINGS_WAKE_TEST_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
