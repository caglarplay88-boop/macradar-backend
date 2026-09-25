const { pool } = require('./db');
const {
  ensureDroppingSchema,
  primeDroppingRows,
  recordDroppingAlert
} = require('./dropping-store');
const {
  flushDroppingPushes,
  buildMessage
} = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const rounds = 8;
  const itemKeys = [];
  const alertIds = [];
  const expectedAlerts = rounds * 2;
  const token = 'TEST_DIFF_RACE_DEVICE_' + stamp;
  let deviceId = null;
  const sentAlertIds = new Set();
  const sentTags = new Set();

  try {
    for (let i = 0; i < rounds; i++) {
      const matchId = 'TEST_DIFF_RACE_MATCH_' + stamp + '_' + i;
      const outcomeId = 'OUTCOME_1';
      const itemKey = matchId + '|' + outcomeId;
      itemKeys.push(itemKey);

      const baseline = {
        matchId,
        outcomeId,
        match: 'Different Odds Race ' + i,
        selection: '1',
        league: 'TEST',
        date: '2026-09-25',
        time: '21:30',
        oldOdd: 2.20,
        currentOdd: 2.10,
        dropPct: 4.55,
        bookiesPct: 30,
        bookiesDown: 3,
        bookiesTotal: 10
      };

      const row200 = {
        ...baseline,
        oldOdd: 2.10,
        currentOdd: 2.00,
        dropPct: 4.76
      };

      const row190 = {
        ...baseline,
        oldOdd: 2.00,
        currentOdd: 1.90,
        dropPct: 5.00
      };

      await primeDroppingRows([baseline]);

      const event200 = {
        type: 'changed',
        before: baseline,
        after: row200
      };
      const event190 = {
        type: 'changed',
        before: row200,
        after: row190
      };

      const pair = i % 2 === 0
        ? [recordDroppingAlert(event200, { pushEligible: true }),
           recordDroppingAlert(event190, { pushEligible: true })]
        : [recordDroppingAlert(event190, { pushEligible: true }),
           recordDroppingAlert(event200, { pushEligible: true })];

      const results = await Promise.all(pair);
      const created = results.filter(Boolean);

      if (created.length !== 2) {
        throw new Error('round ' + i + ' created=' + created.length);
      }

      const odds = created
        .map(row => Number(row.current_odd))
        .sort((a, b) => a - b);

      if (odds.length !== 2 || odds[0] !== 1.90 || odds[1] !== 2.00) {
        throw new Error('round ' + i + ' odds mismatch ' + JSON.stringify(odds));
      }

      alertIds.push(...created.map(row => Number(row.id)));

      const replayA = await recordDroppingAlert(
        event200,
        { pushEligible: true }
      );
      const replayB = await recordDroppingAlert(
        event190,
        { pushEligible: true }
      );

      if (replayA !== null || replayB !== null) {
        throw new Error('round ' + i + ' replay created duplicate');
      }

      const db = await pool.query(
        `SELECT current_odd, count(*)::int AS n
         FROM dropping_alerts
         WHERE item_key=$1
         GROUP BY current_odd
         ORDER BY current_odd`,
        [itemKey]
      );

      if (db.rows.length !== 2 ||
          Number(db.rows[0].current_odd) !== 1.90 ||
          Number(db.rows[0].n) !== 1 ||
          Number(db.rows[1].current_odd) !== 2.00 ||
          Number(db.rows[1].n) !== 1) {
        throw new Error('round ' + i + ' DB mismatch ' + JSON.stringify(db.rows));
      }
    }

    if (new Set(alertIds).size !== expectedAlerts) {
      throw new Error('alert id uniqueness mismatch');
    }

    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'diff-race-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    const flush = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device');
        }
        if (!alertIds.includes(Number(alert.id))) {
          throw new Error('unexpected alert ' + alert.id);
        }

        const message = buildMessage(alert, device.token);
        const expectedTag = 'dropping_alert_' + String(alert.id);

        if (message.message.android.notification.tag !== expectedTag ||
            message.message.android.collapse_key !== expectedTag) {
          throw new Error('notification identity mismatch for alert ' + alert.id);
        }

        sentAlertIds.add(String(alert.id));
        sentTags.add(expectedTag);
        return 'ok';
      }
    });

    if (flush.pending !== expectedAlerts ||
        flush.sentAlerts !== expectedAlerts ||
        flush.sentDevices !== expectedAlerts ||
        flush.failedDevices !== 0 ||
        sentAlertIds.size !== expectedAlerts ||
        sentTags.size !== expectedAlerts) {
      throw new Error('flush mismatch ' + JSON.stringify({
        flush,
        sentAlertIds: sentAlertIds.size,
        sentTags: sentTags.size
      }));
    }

    const secondFlush = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        throw new Error('completed alerts replayed');
      }
    });

    if (secondFlush.pending !== 0 ||
        secondFlush.sentAlerts !== 0 ||
        secondFlush.sentDevices !== 0) {
      throw new Error('second flush mismatch ' + JSON.stringify(secondFlush));
    }

    const allRows = await pool.query(
      `SELECT count(*)::int AS total,
              count(DISTINCT id)::int AS ids,
              count(DISTINCT (item_key,current_odd))::int AS unique_pairs,
              count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );

    const r = allRows.rows[0];
    if (Number(r.total) !== expectedAlerts ||
        Number(r.ids) !== expectedAlerts ||
        Number(r.unique_pairs) !== expectedAlerts ||
        Number(r.sent) !== expectedAlerts) {
      throw new Error('final DB mismatch ' + JSON.stringify(r));
    }

    console.log(
      'DIFFERENT_ODDS_RACE=OK ROUNDS=' + rounds +
      ' EXPECTED_ALERTS=' + expectedAlerts +
      ' CREATED=' + expectedAlerts +
      ' REPLAY_DUPLICATES=0 UNIQUE_ALERT_IDS=' + expectedAlerts +
      ' UNIQUE_TAGS=' + expectedAlerts +
      ' SENDS=' + expectedAlerts +
      ' SECOND_FLUSH=0'
    );
  } finally {
    if (alertIds.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])',
        [alertIds]
      );
    }

    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

    if (itemKeys.length) {
      await pool.query(
        'DELETE FROM dropping_state WHERE item_key = ANY($1::text[])',
        [itemKeys]
      );
    }

    const cleanup = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM dropping_alerts
           WHERE item_key LIKE $1) alerts,
         (SELECT count(*)::int FROM dropping_state
           WHERE item_key LIKE $1) states,
         (SELECT count(*)::int FROM dropping_push_devices
           WHERE token=$2) devices,
         (SELECT count(*)::int FROM dropping_alerts
           WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending`,
      ['TEST_DIFF_RACE_MATCH_' + stamp + '%', token]
    );

    if (Number(cleanup.rows[0].alerts) !== 0 ||
        Number(cleanup.rows[0].states) !== 0 ||
        Number(cleanup.rows[0].devices) !== 0) {
      throw new Error('cleanup mismatch ' + JSON.stringify(cleanup.rows[0]));
    }

    console.log(
      'DIFFERENT_ODDS_RACE_CLEANUP=OK PENDING=' +
      cleanup.rows[0].pending
    );
    await pool.end();
  }
})().catch(async e => {
  console.error('DIFFERENT_ODDS_RACE_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
