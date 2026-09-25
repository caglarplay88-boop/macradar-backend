const crypto = require('crypto');
const fs = require('fs');
const {
  listPendingDroppingPushes,
  listEnabledDroppingPushDevices,
  disableDroppingPushDevice,
  markDroppingPushSent
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
        notification: {
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
    const error = new Error(
      'FCM HTTP ' + response.status + ': ' + text.slice(0, 500)
    );
    error.unregistered = /UNREGISTERED/i.test(text);
    throw error;
  }

  return text;
}

async function flushDroppingPushes({ limit = 25 } = {}) {
  const account = loadServiceAccount();

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

  const accessToken = await getAccessToken(account);

  let sentAlerts = 0;
  let sentDevices = 0;
  let failedDevices = 0;

  for (const alert of alerts) {
    let delivered = 0;
    let transientFailure = false;

    for (const device of devices) {
      try {
        await sendToDevice(account, accessToken, alert, device);
        delivered++;
        sentDevices++;
      } catch (error) {
        if (error.unregistered) {
          await disableDroppingPushDevice(device.token);
          continue;
        }

        transientFailure = true;
        failedDevices++;
        console.error(
          '[dropping-push] alert=' + alert.id +
          ' device=' + device.id +
          ' error=' + (error.message || error)
        );
      }
    }

    if (delivered > 0 && !transientFailure) {
      await markDroppingPushSent(alert.id);
      sentAlerts++;
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
  loadServiceAccount,
  buildMessage,
  flushDroppingPushes
};
