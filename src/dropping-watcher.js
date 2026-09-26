const { DroppingWatcher } = require('./dropping-watcher-core');
const {
  ensureDroppingSchema,
  syncDroppingCurrent,
  loadDroppingState,
  recordDroppingAlert,
  saveDroppingWorkerStatus,
  getDroppingSettings,
  pruneDroppingHistory
} = require('./dropping-store');
const { pool } = require('./db');
const { flushDroppingPushes, isPushConfigured, getDroppingPushReadiness } = require('./dropping-push');

const DAYS_BY_MATCHES_FOR = {
  today: 1,
  today_tomorrow: 2,
  '7d': 7,
  anytime: 0
};

async function createSettingsWakeListener() {
  const client = await pool.connect();
  let pending = false;
  let waiter = null;

  const onNotification = message => {
    if (message.channel !== 'dropping_settings_changed') return;
    pending = true;
    if (waiter) waiter();
  };

  const onError = error => {
    console.error(
      '[dropping] settings-listener ERROR=' + (error.message || error)
    );
  };

  client.on('notification', onNotification);
  client.on('error', onError);
  await client.query('LISTEN dropping_settings_changed');

  return {
    wait(ms) {
      if (pending) {
        pending = false;
        return Promise.resolve('notify');
      }

      return new Promise(resolve => {
        let done = false;
        let timer = null;

        const finish = reason => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          waiter = null;
          if (reason === 'notify') pending = false;
          resolve(reason);
        };

        waiter = () => finish('notify');
        timer = setTimeout(() => finish('timeout'), ms);
      });
    },

    async close() {
      waiter = null;
      client.removeListener('notification', onNotification);
      client.removeListener('error', onError);
      try {
        await client.query('UNLISTEN dropping_settings_changed');
      } finally {
        client.release();
      }
    }
  };
}

function sourceOptions(settings) {
  const days = DAYS_BY_MATCHES_FOR[String(settings.matches_for)];
  if (days === undefined) {
    throw new Error('Gecersiz matches_for ayari: ' + settings.matches_for);
  }

  return {
    hours: Number(settings.drops_in_last_hours),
    days,
    bookies: Number(settings.bookies_pct)
  };
}

async function run() {
  await ensureDroppingSchema();
  const settingsWake = await createSettingsWakeListener();

  const saved = await loadDroppingState();
  const watcher = new DroppingWatcher(saved);
  const maxPolls = Math.max(0, Number(process.env.DROPPING_MAX_POLLS || 0));

  console.log('[dropping] started restored=' + saved.length + ' pushConfigured=' + isPushConfigured());

  let polls = 0;
  let lastSourceKey = null;

  while (true) {
    const started = Date.now();
    let settings = null;

    try {
      settings = await getDroppingSettings();
      if (!settings) throw new Error('Dropping ayarlari bulunamadi.');

      const pollSeconds = Number(settings.poll_seconds);
      if (![15, 30, 60, 120, 300].includes(pollSeconds)) {
        throw new Error('Gecersiz poll_seconds ayari: ' + pollSeconds);
      }

      const options = sourceOptions(settings);
      const sourceKey = [options.hours, options.days, options.bookies].join('|');
      const polled = await watcher.poll(options);
      const filterChanged = lastSourceKey !== null && sourceKey !== lastSourceKey;
      const baselineReset = lastSourceKey === null || filterChanged;
      const rows = polled.rows;
      const result = baselineReset ? watcher.prime(rows) : polled.result;

      await syncDroppingCurrent(rows, { prime: result.primed });
      lastSourceKey = sourceKey;

      let createdAlerts = 0;
      let pushReadiness = {
        configured: isPushConfigured(),
        devices: 0,
        ready: false
      };

      if (settings.notifications_enabled === true) {
        pushReadiness = await getDroppingPushReadiness();
      }

      let pushClaimedThisPoll = false;
      for (const event of result.events) {
        const pushEligible =
          pushReadiness.ready === true && pushClaimedThisPoll === false;
        const alert = await recordDroppingAlert(event, { pushEligible });
        if (!alert) continue;

        if (pushEligible) pushClaimedThisPoll = true;
        createdAlerts++;
        const row = event.after;

        console.log(
          '[dropping] ALERT id=' + alert.id + ' ' +
          row.match + ' ' + row.selection + ' ' +
          (event.before ? event.before.currentOdd : row.oldOdd) +
          ' -> ' + row.currentOdd +
          ' drop=' + row.dropPct + '%'
        );
      }

      let pushResult = { configured: pushReadiness.configured, sentAlerts: 0, sentDevices: 0, failedDevices: 0 };
      if (settings.notifications_enabled === true && pushReadiness.ready === true) {
        try {
          pushResult = await flushDroppingPushes({ limit: 1 });
        } catch (pushError) {
          console.error('[dropping-push] flush error=' + (pushError.message || pushError));
          pushResult = { configured: isPushConfigured(), sentAlerts: 0, sentDevices: 0, failedDevices: 1 };
        }
      }

      try {
        const pruned = await pruneDroppingHistory({ days: 7 });
        if (pruned.alertsDeleted > 0 || pruned.stateDeleted > 0) {
          console.log(
            '[dropping] retention days=7 alerts=' + pruned.alertsDeleted +
            ' state=' + pruned.stateDeleted
          );
        }
      } catch (cleanupError) {
        console.error('[dropping] retention error=' + (cleanupError.message || cleanupError));
      }

      await saveDroppingWorkerStatus({
        ok: true,
        tracked: result.tracked,
        events: createdAlerts,
        intervalSeconds: pollSeconds
      });

      polls++;

      console.log(
        '[dropping] poll=' + polls +
        ' hours=' + options.hours +
        ' days=' + options.days +
        ' bookies=' + options.bookies +
        ' interval=' + pollSeconds +
        ' notifications=' + (settings.notifications_enabled === true) +
        ' filterChanged=' + filterChanged +
        ' baselineReset=' + baselineReset +
        ' pushReady=' + (pushReadiness.ready === true) +
        ' pushDevices=' + Number(pushReadiness.devices || 0) +
        ' tracked=' + result.tracked +
        ' alerts=' + createdAlerts +
        ' push=' + (pushResult.configured ? (pushResult.sentAlerts + '/' + pushResult.sentDevices) : 'disabled') +
        ' primed=' + result.primed +
        ' ms=' + (Date.now() - started)
      );
    } catch (error) {
      polls++;

      const fallbackInterval =
        settings && [15, 30, 60, 120, 300].includes(Number(settings.poll_seconds))
          ? Number(settings.poll_seconds)
          : 60;

      try {
        await saveDroppingWorkerStatus({
          ok: false,
          tracked: watcher.state.size,
          events: 0,
          intervalSeconds: fallbackInterval,
          error: String(error.message || error).slice(0, 1000)
        });
      } catch {}

      console.error(
        '[dropping] poll=' + polls +
        ' ERROR=' + (error.message || error)
      );
    }

    if (maxPolls > 0 && polls >= maxPolls) break;

    const seconds =
      settings && [15, 30, 60, 120, 300].includes(Number(settings.poll_seconds))
        ? Number(settings.poll_seconds)
        : 60;

    const elapsed = Date.now() - started;
    const waitReason = await settingsWake.wait(
      Math.max(1000, seconds * 1000 - elapsed)
    );
    if (waitReason === 'notify') {
      console.log('[dropping] settings changed; waking early');
    }
  }

  console.log('[dropping] stopped polls=' + polls);
  await settingsWake.close();
  await pool.end();
}

run().catch(async error => {
  console.error('[dropping] FATAL=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
