import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import typescript from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "src/lib/forecast-policy.ts");
const source = readFileSync(sourcePath, "utf8");
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
}).outputText;
const policyModule = new Module(sourcePath);
policyModule.filename = sourcePath;
policyModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
policyModule._compile(compiled, sourcePath);

const { decideForecast, evaluateMarkets } = policyModule.exports;
const evidence = {
  confirmedStartingWingers: null,
  noStartingAttackerAbsences: null,
  bothGoalkeepersHighSavesAndGoalsPrevented: false,
  opponentConcedesPenalties: null,
  opponentBuildUpLosses: null,
};

function market(marketType, line, baseCushion, forecastType = "over", team = "both") {
  return { id: marketType, name: marketType, description: "", line, baseCushion, marketType, forecastType, team };
}

function forecast(projection, overrides = {}, marketId = "market", selection = null, probability = 0.7, team = "both") {
  return {
    marketId,
    selection,
    projection,
    probability,
    rationale: "evidence",
    activeRuleIds: [],
    team,
    evidence: { ...evidence, ...overrides },
  };
}

test("corners maintain the configured base range and use explicit upgrade thresholds", () => {
  const corners = market("corners", "6.5", 3.5);
  assert.deepEqual(decideForecast(corners, forecast(10), 3.5), {
    selection: "Over 6.5",
    decision: "maintained",
  });
  assert.equal(decideForecast(corners, forecast(9.9), 3.5).decision, "discarded");
  assert.deepEqual(decideForecast(corners, forecast(12, { confirmedStartingWingers: true }), 3.5), {
    selection: "Over 8.5",
    decision: "upgraded",
  });
  assert.deepEqual(decideForecast(corners, forecast(13, { confirmedStartingWingers: true }), 3.5), {
    selection: "Over 9.5",
    decision: "upgraded",
  });
  assert.match(decideForecast(corners, forecast(12), 3.5).reason, /extremos titulares/);
});

test("active risk shifts specific thresholds and goalkeeper evidence can discard goals", () => {
  const goals = market("totalGoals", "1.5", 0.7);
  assert.deepEqual(decideForecast(goals, forecast(2.2), 0.7), {
    selection: "Over 1.5",
    decision: "maintained",
  });
  assert.deepEqual(decideForecast(goals, forecast(3.2, { noStartingAttackerAbsences: true }), 0.7), {
    selection: "Over 2.5",
    decision: "upgraded",
  });
  assert.equal(decideForecast(goals, forecast(3.2, {
    noStartingAttackerAbsences: true,
    bothGoalkeepersHighSavesAndGoalsPrevented: true,
  }), 0.7).decision, "discarded");
  assert.equal(decideForecast(goals, forecast(3.5, { noStartingAttackerAbsences: true }), 1.05).decision, "discarded");
});

test("team goals require evidence for the opponent condition", () => {
  const teamGoals = market("teamGoals", "0.5", 0.6);
  assert.deepEqual(decideForecast(teamGoals, forecast(1.85, { opponentBuildUpLosses: 111 }), 0.6), {
    selection: "Over 1.5",
    decision: "upgraded",
  });
  assert.match(decideForecast(teamGoals, forecast(1.85), 0.6).reason, /No se confirmó/);
});

test("generic numeric markets maintain at the adjusted floor without escalation", () => {
  const generic = market("generic", "6", 2);
  assert.deepEqual(decideForecast(generic, forecast(8), 2), {
    selection: "Over 6.0",
    decision: "maintained",
  });
  assert.equal(decideForecast(generic, forecast(7.99), 2).decision, "discarded");
});

test("evaluation returns one explicit state for all six markets", () => {
  const markets = ["market-1", "market-2", "market-3", "market-4", "market-5", "market-6"]
    .map((id) => ({ ...market("generic", "1", 1), id }));
  const evaluations = [
    forecast(2, {}, "market-1"),
    forecast(1.5, {}, "market-2"),
    forecast(null, {}, "market-3"),
    forecast(3, {}, "market-6"),
  ];

  const result = evaluateMarkets(markets, evaluations, []);

  assert.equal(result.verdicts.length + result.discardedMarkets.length, 6);
  assert.deepEqual(result.verdicts.map((item) => item.marketId), ["market-1", "market-6"]);
  assert.equal(result.discardedMarkets.length, 4);
  assert.ok(result.discardedMarkets.every((item) => item.reason.length > 0));
  assert.equal(result.discardedMarkets.find((item) => item.marketId === "market-3").projection, null);
});

test("missing or invalid active rule IDs cannot be treated as zero risk", () => {
  const generic = { ...market("generic", "1", 0.5), id: "missing-rules" };
  const sibling = { ...market("generic", "1", 0.5), id: "valid-sibling" };
  const result = evaluateMarkets(
    [generic, sibling],
    [
      { ...forecast(3, {}, generic.id), activeRuleIds: null },
      forecast(2, {}, sibling.id),
    ],
    [],
  );

  assert.deepEqual(result.verdicts.map((item) => item.marketId), ["valid-sibling"]);
  assert.match(result.discardedMarkets[0].reason, /colchón ajustado/);
});

test("under markets require projection at or below line minus adjusted cushion", () => {
  const under = market("totalGoals", "2.5", 0.5, "under");
  assert.deepEqual(decideForecast(under, forecast(2), 0.5), {
    selection: "Under 2.5",
    decision: "maintained",
  });
  assert.match(decideForecast(under, forecast(2.01), 0.5).reason, /Zona muerta/);
  assert.deepEqual(decideForecast(under, forecast(1.5), 1), {
    selection: "Under 2.5",
    decision: "maintained",
  });
});

test("moneyline and handicap decisions use candidate selection probability", () => {
  const moneyline = market("generic", "1X2", 0, "moneyline");
  assert.deepEqual(decideForecast(moneyline, forecast(null, {}, "winner", "Local", 0.6), 0), {
    selection: "Local",
    decision: "maintained",
  });
  assert.match(decideForecast(moneyline, forecast(null, {}, "winner", "Local", 0.54), 0).reason, /55%/);
  assert.match(decideForecast(moneyline, forecast(null, {}, "winner", null, 0.8), 0).reason, /selección candidata/);

  const handicap = market("handicap", "-1.0/-1.5", 0.1, "handicap", "home");
  assert.equal(decideForecast(handicap, forecast(null, {}, "cover", "Local -1.0", 0.65), 0.1).decision, "maintained");
});

test("low projections pivot an over market to the opposite under selection", () => {
  const corners = market("corners", "6.5", 3.5);
  assert.deepEqual(decideForecast(corners, forecast(4.5), 3.5), {
    selection: "Under 6.5",
    decision: "inverted_suggestion",
  });

  const goals = market("totalGoals", "1.5", 0.7);
  assert.deepEqual(decideForecast(goals, forecast(1), 0.7), {
    selection: "Under 1.5",
    decision: "inverted_suggestion",
  });
});

test("an under market can pivot to over when the projection clears the over policy", () => {
  const cornersUnder = market("corners", "6.5", 2, "under");
  assert.deepEqual(decideForecast(cornersUnder, forecast(10), 2), {
    selection: "Over 6.5",
    decision: "inverted_suggestion",
  });
  assert.deepEqual(decideForecast(cornersUnder, forecast(12, { confirmedStartingWingers: true }), 2), {
    selection: "Over 8.5",
    decision: "inverted_suggestion",
  });
});

test("dead-zone projections explain equilibrium instead of a generic miss", () => {
  const corners = market("corners", "6.5", 3.5);
  assert.match(decideForecast(corners, forecast(9.9), 3.5).reason, /Zona muerta/);

  const generic = market("generic", "6", 2);
  assert.match(decideForecast(generic, forecast(7.99), 2).reason, /Zona muerta/);
});

test("categorical markets are evaluated without a numeric projection", () => {
  const moneyline = { ...market("generic", "1X2", 0, "moneyline"), id: "winner" };
  const result = evaluateMarkets(
    [moneyline],
    [forecast(null, {}, "winner", "Local", 0.6)],
    [],
  );

  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].selection, "Local");
  assert.equal(result.verdicts[0].projection, null);
  assert.equal(result.discardedMarkets.length, 0);

  const missingSelection = evaluateMarkets(
    [moneyline],
    [forecast(null, {}, "winner", null, 0.6)],
    [],
  );
  assert.match(missingSelection.discardedMarkets[0].reason, /selección candidata/);

  const missingProbability = evaluateMarkets(
    [moneyline],
    [{ ...forecast(null, {}, "winner", "Local"), probability: null }],
    [],
  );
  assert.match(missingProbability.discardedMarkets[0].reason, /probabilidad válida/);
});