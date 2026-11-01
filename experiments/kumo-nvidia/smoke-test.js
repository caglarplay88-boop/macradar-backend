#!/usr/bin/env node
'use strict';

// NVIDIA Kumo Tabular hosted API smoke test.
// Safely uses SYNTHETIC football examples only; it does NOT read MacRadar DB.
// Runs offline by default. To actually call NVIDIA: NVIDIA_API_KEY=... node smoke-test.js --send
const ENDPOINT = 'https://ai.api.nvidia.com/v1/structured-data/nvidia/kumo-tabular/predictions';

const columns = ['match_id', 'league', 'home_odd', 'draw_odd', 'away_odd'];
const contextRows = [
  ['sample-01','TR',1.45,4.40,7.50,'H'],
  ['sample-02','TR',2.60,3.15,2.65,'D'],
  ['sample-03','TR',3.60,3.30,1.90,'A'],
  ['sample-04','EN',1.35,5.10,8.20,'H'],
  ['sample-05','EN',2.80,3.05,2.55,'D'],
  ['sample-06','EN',4.25,3.75,1.75,'A'],
  ['sample-07','DE',1.62,3.95,5.60,'H'],
  ['sample-08','DE',2.95,3.12,2.45,'D'],
  ['sample-09','DE',4.50,3.70,1.70,'A'],
  ['sample-10','ES',1.55,4.15,6.00,'H'],
  ['sample-11','ES',2.65,3.00,2.85,'D'],
  ['sample-12','ES',3.95,3.55,1.84,'A']
];
// These examples are invented solely to test the API request format.
// They must NOT be used to evaluate accuracy or produce actual betting advice.
const queryRows = [['sample-future','TR',2.10,3.20,3.40]];

function makePayload() {
  return {
    model: 'kumo-tabular',
    task: {
      kind: 'classification',
      target: {
        column_name: 'result',
        dtype: 'string',
        classes: ['H', 'D', 'A']
      }
    },
    schema: {
      instance_table: {
        columns: {
          match_id: { dtype: 'string', stype: 'ID', nullable: false },
          league: { dtype: 'string', stype: 'categorical' },
          home_odd: { dtype: 'float64', stype: 'numerical' },
          draw_odd: { dtype: 'float64', stype: 'numerical' },
          away_odd: { dtype: 'float64', stype: 'numerical' },
          result: { dtype: 'string', stype: 'categorical' }
        },
        primary_key: 'match_id'
      },
      related_tables: {},
      relationships: []
    },
    context: {
      instance_table: {
        format: 'arrays',
        columns: [...columns, 'result'],
        rows: contextRows
      },
      related_tables: {}
    },
    predict: {
      instance_table: {
        format: 'arrays',
        columns,
        rows: queryRows
      },
      related_tables: {}
    },
    output: { fields: ['prediction', 'probabilities'] },
    metadata: { request_id: 'macradar-kumo-synthetic-smoke-v1' }
  };
}

async function main() {
  const payload = makePayload();
  if (!process.argv.includes('--send')) {
    console.log('DRY RUN: API cagirilMADI. Sadece ornek istek hazirlandi.');
    console.log('Context satiri:', contextRows.length, 'Tahmin satiri:', queryRows.length);
    console.log('Gercek deneme: NVIDIA_API_KEY ortam degiskenini ayarlayip --send kullan.');
    return;
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error('NVIDIA_API_KEY eksik. Anahtari koda veya GitHub a yazmayin.');
    process.exitCode = 2;
    return;
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000)
  });

  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch { result = { message: raw.slice(0, 1200) }; }

  if (!response.ok) {
    console.error('NVIDIA API hata HTTP', response.status);
    console.error(JSON.stringify(result).slice(0, 2000));
    process.exitCode = 1;
    return;
  }

  console.log('NVIDIA baglantisi BASARILI. Yanıt (sentetik veri):');
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
}

main().catch(e => {
  console.error('Istek basarisiz:', e.message);
  process.exitCode = 1;
});
