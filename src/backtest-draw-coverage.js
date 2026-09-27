const { buildMlReadyRows } = require('./backtest-features');

const GROUPS = {
  xg: /(?:^|__)(?:xg|xga|understat|expectedgoals?|expected_goals?)(?:__|$)/i,
  shots_quality: /(?:shot|shots|sot|ontarget|offtarget|bigchance|big_chance|finishing|conversion)/i,
  possession_tempo: /(?:possession|fieldtilt|field_tilt|tempo|attack|attacks|progression|finalthird|final_third)/i,
  scoring_balance: /(?:goal|goals|scored|conceded|gf|ga|result|form)/i
};

function isPresent(value) {
  return value !== null && value !== undefined &&
    !(typeof value === 'number' && !Number.isFinite(value));
}

function summarizeGroup(rows, featureNames) {
  const labels = ['HOME', 'DRAW', 'AWAY'];
  const byLabel = {};

  for (const label of labels) {
    const selectedRows = rows.filter(r => r.label_1x2 === label);
    let present = 0;
    let total = 0;
    const perFeature = [];

    for (const name of featureNames) {
      let featurePresent = 0;
      for (const row of selectedRows) {
        total++;
        if (isPresent(row.features[name])) {
          present++;
          featurePresent++;
        }
      }
      perFeature.push({
        name,
        presence_ratio: selectedRows.length
          ? featurePresent / selectedRows.length
          : null
      });
    }

    byLabel[label] = {
      row_count: selectedRows.length,
      feature_count: featureNames.length,
      cell_presence_ratio: total ? present / total : null,
      fully_present_features: perFeature.filter(x => x.presence_ratio === 1).length,
      at_least_half_present_features: perFeature.filter(x => x.presence_ratio >= 0.5).length
    };
  }

  return byLabel;
}

function analyzeDrawCoverage(rawRows) {
  const dataset = buildMlReadyRows(rawRows);
  const groups = {};

  for (const [group, pattern] of Object.entries(GROUPS)) {
    const names = dataset.feature_names.filter(name => pattern.test(name));
    pattern.lastIndex = 0;
    groups[group] = {
      feature_count: names.length,
      by_label: summarizeGroup(dataset.rows, names),
      sample_features: names.slice(0, 20)
    };
  }

  const providers = {};
  for (const row of rawRows) {
    const label = row.label_1x2;
    const provider = row.provider || 'NULL';
    providers[label] ||= {};
    providers[label][provider] = (providers[label][provider] || 0) + 1;
  }

  const drawRows = dataset.rows.filter(r => r.label_1x2 === 'DRAW');
  const nonDrawRows = dataset.rows.filter(r => r.label_1x2 !== 'DRAW');

  const drawSpecific = [];
  for (const name of dataset.feature_names) {
    const drawPresent = drawRows.length
      ? drawRows.filter(r => isPresent(r.features[name])).length / drawRows.length
      : 0;
    const nonDrawPresent = nonDrawRows.length
      ? nonDrawRows.filter(r => isPresent(r.features[name])).length / nonDrawRows.length
      : 0;

    drawSpecific.push({
      name,
      draw_presence: drawPresent,
      non_draw_presence: nonDrawPresent,
      gap: drawPresent - nonDrawPresent
    });
  }

  drawSpecific.sort((a, b) =>
    Math.abs(b.gap) - Math.abs(a.gap) ||
    a.name.localeCompare(b.name)
  );

  return {
    meta: {
      row_count: dataset.rows.length,
      feature_count: dataset.feature_names.length,
      draw_count: drawRows.length,
      non_draw_count: nonDrawRows.length
    },
    providers,
    groups,
    largest_presence_gaps: drawSpecific.slice(0, 40)
  };
}

module.exports = {
  GROUPS,
  analyzeDrawCoverage
};

