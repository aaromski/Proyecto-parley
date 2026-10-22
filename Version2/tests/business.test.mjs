import assert from "node:assert/strict";
import test from "node:test";
import { canSaveApprovedPick, evaluateDecision, filterUpcomingFixtures, MARKET_DEFINITIONS, parlayBlockReason } from "../src/lib/analysis.ts";
import { buildParlayEvidence } from "../src/lib/server/explanations.ts";
import { createRequestPacer, FOOTBALL_MIN_REQUEST_INTERVAL_MS, getRetryDelaySeconds, splitUtcDateRange } from "../src/lib/server/football-api-limits.ts";
import { readSlip, saveApprovedPick, SLIP_STORAGE_KEY } from "../src/lib/slip-store.ts";

const safeRisks = { spine: false, goal_overs_under_four_days: false, keeper_goals_prevented: false, opponent_duels_and_clearances: false };
const approvedConfig = { enabled: true, baseCushion: 1, rule: { metric: "goals_for", operator: "gte", threshold: 2 } };
const evidence = { goals_for: { status: "derived", value: 3.4, formula: "goles a favor / partidos", sampleSize: 5 } };

test("football provider requests are paced below ten requests per minute", async () => {
  let now = 0;
  const waits = [];
  const pace = createRequestPacer(FOOTBALL_MIN_REQUEST_INTERVAL_MS, () => now, async (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
  });

  await Promise.all(Array.from({ length: 11 }, () => pace()));

  assert.equal(waits.length, 10);
  assert.ok(waits.every((milliseconds) => milliseconds === FOOTBALL_MIN_REQUEST_INTERVAL_MS));
  assert.ok(now >= 60_000);
});

test("provider rate-limit responses defer queued requests for the reset interval", async () => {
  let now = 0;
  const waits = [];
  const pace = createRequestPacer(FOOTBALL_MIN_REQUEST_INTERVAL_MS, () => now, async (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
  });

  pace.defer(60_000);
  await pace();

  assert.deepEqual(waits, [60_000]);
});

test("a rate-limit response extends a provider request wait already in progress", async () => {
  let now = 0;
  const waits = [];
  let pace;
  pace = createRequestPacer(FOOTBALL_MIN_REQUEST_INTERVAL_MS, () => now, async (milliseconds) => {
    waits.push(milliseconds);
    if (waits.length === 1) pace.defer(60_000);
    now += milliseconds;
  });

  await pace();
  await pace();

  assert.deepEqual(waits, [FOOTBALL_MIN_REQUEST_INTERVAL_MS, 60_000 - FOOTBALL_MIN_REQUEST_INTERVAL_MS]);
  assert.equal(now, 60_000);
});

test("provider retry delay honors Retry-After seconds and HTTP dates before reset fallback", () => {
  assert.equal(getRetryDelaySeconds("12.2", "60", 0), 13);
  assert.equal(getRetryDelaySeconds(new Date(20_000).toUTCString(), "60", 0), 20);
  assert.equal(getRetryDelaySeconds(null, "9.1", 0), 10);
  assert.equal(getRetryDelaySeconds(null, null, 0), 60);
});

test("provider date windows span no more than ten UTC calendar days without gaps", () => {
  assert.deepEqual(splitUtcDateRange(new Date("2026-10-21T00:00:00.000Z"), new Date("2026-11-04T23:59:59.999Z")), [
    { from: "2026-10-21", to: "2026-10-30" },
    { from: "2026-10-31", to: "2026-11-04" },
  ]);
});

test("the four deterministic verdicts follow the configured threshold and cushion", () => {
  const evaluate = (value) => evaluateDecision({
    marketId: "simple_win",
    config: approvedConfig,
    metrics: { adjusted_net_xg_difference: { status: "observed", value } },
    riskSettings: safeRisks,
    riskEvidence: {},
  });

  assert.equal(evaluate(1.31).verdict, "SUBIR LÍNEA");
  assert.equal(evaluate(1).verdict, "APROBADO LÍNEA BASE");
  assert.equal(evaluate(0.5).verdict, "REDUCIR RIESGO");
  assert.equal(evaluate(-0.1).verdict, "DESCARTADO POR VARIANZA");
});

test("missing data or base cushion never produces an approval", () => {
  const cases = [
    { config: { enabled: true, baseCushion: null, rule: approvedConfig.rule }, metrics: evidence },
    { config: approvedConfig, metrics: { adjusted_net_xg_difference: { status: "unavailable", reason: "sin cobertura" } } },
  ];
  for (const value of cases) {
    const decision = evaluateDecision({ marketId: "simple_win", ...value, riskSettings: safeRisks, riskEvidence: {} });
    assert.equal(decision.evaluation, "NOT_EVALUABLE");
    assert.equal(canSaveApprovedPick(decision), false);
  }
});

test("risk modifiers compound on the base cushion and missing enabled risk evidence blocks evaluation", () => {
  const decision = evaluateDecision({
    marketId: "individual_over_0_5",
    config: { ...approvedConfig, rule: null },
    metrics: { individual_expected_goals: { status: "observed", value: 3.4 } },
    riskSettings: { spine: false, goal_overs_under_four_days: true, keeper_goals_prevented: true },
    riskEvidence: { goal_overs_under_four_days: true, keeper_goals_prevented: true },
  });
  assert.equal(decision.adjustedCushion, 1.35);
  assert.equal(decision.riskFactors.filter((factor) => factor.state === "applied").length, 2);

  const unknownRisk = evaluateDecision({
    marketId: "individual_over_0_5",
    config: { ...approvedConfig, rule: null },
    metrics: { individual_expected_goals: { status: "observed", value: 3.4 } },
    riskSettings: { spine: false, goal_overs_under_four_days: true },
    riskEvidence: { goal_overs_under_four_days: null },
  });
  assert.equal(unknownRisk.evaluation, "NOT_EVALUABLE");
});

test("fixed market lines are exact and unsupported market evidence remains unavailable", () => {
  const cases = [
    ["handicap_minus_one", "expected_goal_difference", 1.1],
    ["corners_over_6_5", "corner_projection", 6.5],
    ["total_over_1_5", "combined_expected_goals", 1.5],
    ["individual_over_0_5", "individual_expected_goals", 0.5],
  ];
  for (const [marketId, metric, line] of cases) {
    const definition = MARKET_DEFINITIONS.find((market) => market.id === marketId);
    assert.equal(definition.line, line);
    assert.equal(definition.metric, metric);
    const result = evaluateDecision({
      marketId,
      config: { enabled: true, baseCushion: 1, rule: { metric: "goals_for", operator: "gte", threshold: 0 } },
      metrics: {
        goals_for: { status: "observed", value: 100 },
        [metric]: { status: "unavailable", reason: "football-data.org no proporciona esta métrica" },
      },
      riskSettings: safeRisks,
    });
    assert.equal(result.threshold, null);
    assert.equal(result.evaluation, "NOT_EVALUABLE");
    assert.ok(result.reason.includes("Falta un dato requerido"));
  }
});

test("market cushions reproduce the supplied protected lines without double counting", () => {
  const cases = [
    ["simple_win", "adjusted_net_xg_difference", 0, 0.4, 0.4],
    ["double_chance", "adjusted_net_xg_difference", 0, 0.15, 0.15],
    ["corners_over_6_5", "corner_projection", 6.5, 3.5, 10],
    ["total_over_1_5", "combined_expected_goals", 1.5, 1.2, 2.7],
    ["individual_over_0_5", "individual_expected_goals", 0.5, 0.8, 1.3],
  ];
  for (const [marketId, metric, line, baseCushion, protectedLine] of cases) {
    const definition = MARKET_DEFINITIONS.find((market) => market.id === marketId);
    assert.equal(definition.line, line);
    assert.equal(definition.baseCushion, baseCushion);
    const decision = evaluateDecision({
      marketId,
      config: { enabled: true, baseCushion, rule: null },
      metrics: { [metric]: { status: "observed", value: protectedLine } },
      riskSettings: safeRisks,
      riskEvidence: {},
    });
    assert.equal(decision.evaluation, "EVALUABLE", marketId);
    assert.equal(decision.verdict, "APROBADO LÍNEA BASE", marketId);
  }
});

test("simple win and double chance cannot substitute goals for unavailable net xG", () => {
  for (const marketId of ["simple_win", "double_chance"]) {
    const baseCushion = MARKET_DEFINITIONS.find((market) => market.id === marketId).baseCushion;
    const decision = evaluateDecision({
      marketId,
      config: { enabled: true, baseCushion, rule: { metric: "goals_for", operator: "gte", threshold: 0 } },
      metrics: {
        goals_for: { status: "observed", value: 10 },
        adjusted_net_xg_difference: { status: "unavailable", reason: "xG no disponible" },
      },
      riskSettings: safeRisks,
      riskEvidence: {},
    });
    assert.equal(decision.evaluation, "NOT_EVALUABLE", marketId);
    assert.equal(canSaveApprovedPick(decision), false);
  }
});

test("fixture filtering keeps only future fixtures in the requested season", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const fixtures = [
    { id: 1, season: 2026, kickoff: "2026-10-21T12:01:00.000Z", status: "TIMED" },
    { id: 2, season: 2026, kickoff: "2026-10-21T11:00:00.000Z", status: "TIMED" },
    { id: 3, season: 2025, kickoff: "2026-10-22T11:00:00.000Z", status: "TIMED" },
    { id: 4, season: 2026, kickoff: "2026-10-23T11:00:00.000Z", status: "FINISHED" },
  ];
  assert.deepEqual(filterUpcomingFixtures(fixtures, 2026, now).map((fixture) => fixture.id), [1]);
});

test("local persistence accepts approved picks only and flags incompatible stored data", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const selection = {
    id: "match-10-simple-win-home", matchId: 10, season: 2026, teamId: 1,
    teamName: "Local", opponentName: "Visitante", kickoff: "2026-10-25T12:00:00Z",
    competitionName: "Liga", marketId: "simple_win", marketName: "Victoria Simple",
    selectionId: "home", verdict: "APROBADO LÍNEA BASE", ruleVersion: "local-1", savedAt: "2026-10-21T12:00:00Z",
  };
  const decision = { evaluation: "EVALUABLE", verdict: "APROBADO LÍNEA BASE" };

  assert.equal(saveApprovedPick(storage, selection, decision).length, 1);
  assert.equal(readSlip(storage).selections[0].id, selection.id);
  assert.throws(() => saveApprovedPick(storage, selection, { evaluation: "NOT_EVALUABLE", verdict: null }));
  values.set(SLIP_STORAGE_KEY, "{bad json");
  assert.equal(readSlip(storage).invalid, true);
});


test("parlay builder blocks repeated teams, incompatible outcomes, and a fifth pick", () => {
  const pick = (teamId, marketId, selectionId, matchId = 20) => ({ teamId, marketId, selectionId, matchId });
  assert.equal(parlayBlockReason(pick(1, "simple_win", "home"), [pick(1, "total_over_1_5", "match", 21)]), "Equipo repetido");
  assert.equal(parlayBlockReason(pick(2, "simple_win", "away"), [pick(1, "simple_win", "home")]), "Selecciones contradictorias");
  assert.equal(parlayBlockReason(pick(2, "double_chance", "away_or_draw"), [pick(1, "simple_win", "home")]), "Selecciones contradictorias");
  assert.equal(parlayBlockReason(pick(2, "double_chance", "away_or_draw"), [pick(1, "simple_win", "away")]), null);
  assert.equal(parlayBlockReason(pick(5, "total_over_1_5", "match", 25), [1, 2, 3, 4].map((teamId) => pick(teamId, "simple_win", "home", teamId + 30))), "Máximo de cuatro equipos");
});

test("parlay evidence keeps the selected picks readable and traceable", () => {
  const evidence = buildParlayEvidence([
    { matchId: 10, teamName: "Juventus", opponentName: "Lazio", marketName: "Victoria Simple", selectionLabel: "Local", kickoff: "2026-10-25T20:00:00Z" },
    { matchId: 11, teamName: "Inter", opponentName: "Napoli", marketName: "Alta Total 1.5", selectionLabel: "Más de 1.5 goles", kickoff: "2026-10-26T18:00:00Z" },
  ]);
  assert.equal(evidence.length, 2);
  assert.match(evidence[0].text, /Juventus/);
  assert.match(evidence[0].text, /Victoria Simple/);
  assert.match(evidence[1].text, /Más de 1.5 goles/);
});