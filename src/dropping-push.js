const crypto = require('crypto');
const fs = require('fs');
const {
  listPendingDroppingPushes,
  tryAcquireDroppingPushAlertLock,
  listEnabledDroppingPushDevices,
  listDeliveredDroppingPushDeviceIds,
  markDroppingPushDeviceResult,
  disableDroppingPushDevice,
  markDroppingPushAttempt,
  markDroppingPushSent,
  markDroppingPushIneligible
} = require('./dropping-store');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedAccessToken = null;
let cachedAccessTokenUntil = 0;

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function loadServiceAccount() {
  let raw = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    raw = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_B64,
      'base64'
    ).toString('utf8');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    raw = fs.readFileSync(
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      'utf8'
    );
  } else {
    return null;
  }

  const account = JSON.parse(raw);
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    account.project_id;

  if (!projectId || !account.client_email || !account.private_key) {
    throw new Error('Firebase service account eksik alan iceriyor.');
  }

  return {
    projectId: String(projectId),
    clientEmail: String(account.client_email),
    privateKey: String(account.private_key)
  };
}

function isPushConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

async function getDroppingPushReadiness() {
  let account = null;

  try {
    account = loadServiceAccount();
  } catch (error) {
    return {
      configured: false,
      devices: 0,
      ready: false,
      error: String(error.message || error)
    };
  }

  if (!account) {
    return { configured: false, devices: 0, ready: false };
  }

  const devices = await listEnabledDroppingPushDevices();
  return {
    configured: true,
    devices: devices.length,
    ready: devices.length > 0
  };
}

async function getAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);

  if (cachedAccessToken && cachedAccessTokenUntil > now + 300) {
    return cachedAccessToken;
  }

  const header = base64Url(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT'
  }));

  const claims = base64Url(JSON.stringify({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  const unsigned = header + '.' + claims;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(unsigned),
    account.privateKey
  );

  const assertion = unsigned + '.' + base64Url(signature);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    throw new Error(
      'Firebase OAuth hata ' +
      response.status + ': ' +
      JSON.stringify(body).slice(0, 500)
    );
  }

  cachedAccessToken = String(body.access_token);
  cachedAccessTokenUntil =
    now + Math.max(300, Number(body.expires_in || 3600));

  return cachedAccessToken;
}

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function buildMessage(alert, deviceToken) {
  const before = alert.previous_odd;
  const current = alert.current_odd;
  const drop = alert.drop_pct;

  return {
    message: {
      token: deviceToken,
      notification: {
        title: 'Oran Dususu " ' + stringValue(alert.selection || '?'),
        body:
          stringValue(alert.match_name) + ': ' +
          stringValue(before) + ' -> ' +
          stringValue(current) + ' (-' +
          stringValue(drop) + '%)'
      },
      data: {
        type: 'dropping_odds',
        alert_id: stringValue(alert.id),
        match_id: stringValue(alert.match_id),
        outcome_id: stringValue(alert.outcome_id),
        match: stringValue(alert.match_name),
        selection: stringValue(alert.selection),
        previous_odd: stringValue(before),
        current_odd: stringValue(current),
        drop_pct: stringValue(drop),
        bookies_pct: stringValue(alert.bookies_pct),
        bookies_down: stringValue(alert.bookies_down),
        bookies_total: stringValue(alert.bookies_total)
      },
      android: {
        priority: 'HIGH',
        ttl: '300s',
        collapse_key: 'dropping_alert_' + stringValue(alert.id),
        notification: {
          tag: 'dropping_alert_' + stringValue(alert.id),
          channel_id: 'macradar_dropping_live_v2',
          sound: 'dropping_alert',
          default_vibrate_timings: true,
          visibility: 'PUBLIC',
          notification_priority: 'PRIORITY_MAX'
        }
      }
    }
  };
}

async function sendToDevice(account, accessToken, alert, device) {
  const response = await fetch(
    'https://fcm.googleapis.com/v1/projects/' +
      encodeURIComponent(account.projectId) +
      '/messages:send',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + accessToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildMessage(alert, device.token))
    }
  );

  const text = await response.text();

  if (!response.ok) {
    const authRejected = response.status === 401 || response.status === 403;
    if (authRejected) {
      cachedAccessToken = null;
      cachedAccessTokenUntil = 0;
    }

    const error = new Error(
      'FCM HTTP ' + response.status + ': ' + text.slice(0, 500)
    );
    error.unregistered = /UNREGISTERED/i.test(text);
    error.authRejected = authRejected;
    throw error;
  }

  return text;
}

async function flushDroppingPushes({
  limit = 25,
  accountOverride = null,
  accessTokenOverride = null,
  sendImpl = sendToDevice
} = {}) {
  const account = accountOverride || loadServiceAccount();

  if (!account) {
    return {
      configured: false,
      sentAlerts: 0,
      sentDevices: 0,
      failedDevices: 0
    };
  }

  const alerts = await listPendingDroppingPushes(limit);
  if (!alerts.length) {
    return {
      configured: true,
      pending: 0,
      sentAlerts: 0,
      sentDevices: 0,
      failedDevices: 0
    };
  }

  const devices = await listEnabledDroppingPushDevices();
  if (!devices.length) {
    return {
      configured: true,
      pending: alerts.length,
      sentAlerts: 0,
      sentDevices: 0,
      failedDevices: 0
    };
  }

  let accessToken = accessTokenOverride;
  try {
    if (!accessToken) {
      accessToken = await getAccessToken(account);
    }
  } catch (error) {
    const message = 'FCM auth: ' + String(error.message || error);
    for (const alert of alerts) {
      await markDroppingPushAttempt(alert.id, message);
    }
    throw error;
  }

  let sentAlerts = 0;
  let sentDevices = 0;
  let failedDevices = 0;
  let stopForAuthRefresh = false;
  const disabledDeviceIds = new Set();

  for (const alert of alerts) {
    const alertLock = await tryAcquireDroppingPushAlertLock(alert.id);
    if (!alertLock) {
      continue;
    }

    try {
    let delivered = 0;
    let transientFailure = false;
    const attemptErrors = [];
    const deliveredDeviceIds = new Set(
      await listDeliveredDroppingPushDeviceIds(alert.id)
    );

    for (const device of devices) {
      const deviceId = String(device.id);
      if (disabledDeviceIds.has(deviceId) || deliveredDeviceIds.has(deviceId)) {
        continue;
      }

      try {
        await sendImpl(account, accessToken, alert, device);
        await markDroppingPushDeviceResult(
          alert.id,
          device.id,
          { sent: true }
        );
        deliveredDeviceIds.add(deviceId);
        delivered++;
        sentDevices++;
      } catch (error) {
        if (error.unregistered) {
          await markDroppingPushDeviceResult(
            alert.id,
            device.id,
            { error: 'UNREGISTERED' }
          );
          await disableDroppingPushDevice(device.token);
          disabledDeviceIds.add(deviceId);
          attemptErrors.push(
            'device=' + device.id + ' UNREGISTERED'
          );
          continue;
        }

        transientFailure = true;
        failedDevices++;
        const message = String(error.message || error);
        await markDroppingPushDeviceResult(
          alert.id,
          device.id,
          { error: message }
        );
        attemptErrors.push(
          'device=' + device.id + ' ' + message
        );
        console.error(
          '[dropping-push] alert=' + alert.id +
          ' device=' + device.id +
          ' error=' + message
        );

        if (error.authRejected) {
          stopForAuthRefresh = true;
          break;
        }
      }
    }

    const attemptError =
      transientFailure || deliveredDeviceIds.size === 0
        ? (
            attemptErrors.join(' | ') ||
            'No FCM device accepted the alert.'
          )
        : null;

    await markDroppingPushAttempt(alert.id, attemptError);

    if (deliveredDeviceIds.size > 0 && !transientFailure) {
      await markDroppingPushSent(alert.id);
      sentAlerts++;
    } else if (
      !transientFailure &&
      devices.length > 0 &&
      devices.every(device => disabledDeviceIds.has(String(device.id)))
    ) {
      await markDroppingPushIneligible(alert.id);
    }

    if (stopForAuthRefresh) {
      break;
    }
    } finally {
      await alertLock.release();
    }
  }

  return {
    configured: true,
    pending: alerts.length,
    sentAlerts,
    sentDevices,
    failedDevices
  };
}

module.exports = {
  isPushConfigured,
  getDroppingPushReadiness,
  loadServiceAccount,
  buildMessage,
  flushDroppingPushes
};
