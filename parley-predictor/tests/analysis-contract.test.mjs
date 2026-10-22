import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import typescript from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "src/lib/analysis-contract.ts");
const source = readFileSync(sourcePath, "utf8");
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
}).outputText;
const contractModule = new Module(sourcePath);
contractModule.filename = sourcePath;
contractModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
contractModule._compile(compiled, sourcePath);

const { parseAnalysisRequest, parseModelVerdicts, parseNormalizedData } = contractModule.exports;
const policyPath = path.join(projectRoot, "src/lib/forecast-policy.ts");
const policySource = readFileSync(policyPath, "utf8");
const compiledPolicy = typescript.transpileModule(policySource, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
}).outputText;
const policyModule = new Module(policyPath);
policyModule.filename = policyPath;
policyModule.paths = Module._nodeModulePaths(path.dirname(policyPath));
policyModule._compile(compiledPolicy, policyPath);
const { evaluateMarkets } = policyModule.exports;

test("analysis request accepts supported market types and rejects unsupported ones", () => {
  const request = {
    rawMatchData: "Partido de prueba",
    markets: [{
      id: "goals",
      name: "Goles totales",
      description: "",
      line: "1.5",
      baseCushion: 0.7,
      marketType: "totalGoals",
    }],
    rules: [{
      id: "goalkeeping",
      name: "Portería",
      instructions: "",
      riskFactor: 0.2,
      trigger: "goalkeeping",
    }, {
      id: "penalties",
      name: "Penales",
      instructions: "",
      riskFactor: 0.1,
      trigger: "penalties",
    }],
  };

  assert.equal(parseAnalysisRequest(request).markets[0].marketType, "totalGoals");
  assert.equal(parseAnalysisRequest(request).markets[0].forecastType, "over");
  assert.equal(parseAnalysisRequest(request).markets[0].team, "both");
  const legacyMarket = {
    id: "total-goals-over-1-5",
    name: "Goles totales Over 1.5",
    description: "",
    line: "1.5",
    baseCushion: 0.7,
  };
  const parsedLegacy = parseAnalysisRequest({ ...request, markets: [legacyMarket] }).markets[0];
  assert.equal(parsedLegacy.marketType, "totalGoals");
  assert.equal(parsedLegacy.forecastType, "over");
  assert.equal(parsedLegacy.team, "both");
  assert.throws(() => parseAnalysisRequest({
    ...request,
    markets: [{ ...request.markets[0], marketType: "unknown" }],
  }));
  assert.equal(parseAnalysisRequest({
    ...request,
    markets: [{ ...legacyMarket, id: "match-winner-1x2", line: "1X2", name: "Ganador" }],
  }).markets[0].forecastType, "moneyline");
  assert.throws(() => parseAnalysisRequest({
    ...request,
    markets: [{ ...request.markets[0], forecastType: "invalid" }],
  }));
  const homeHandicap = parseAnalysisRequest({
    ...request,
    markets: [{
      id: "handicap-home-minus-1-0-minus-1-5",
      name: "Hándicap Local -1.0/-1.5",
      description: "",
      line: "-1.0/-1.5",
      baseCushion: 0,
      marketType: "handicap",
      forecastType: "handicap",
      team: "home",
    }],
  }).markets[0];
  assert.equal(homeHandicap.team, "home");
  assert.equal(parseAnalysisRequest({
    ...request,
    markets: [{
      id: "individual-goal-away-over-0-5",
      name: "Gol individual Visitante Over 0.5",
      description: "",
      line: "0.5",
      baseCushion: 0.6,
    }],
  }).markets[0].team, "away");
  assert.throws(() => parseAnalysisRequest({
    ...request,
    markets: [{ ...request.markets[0], team: "neutral" }],
  }));
});

test("model verdict parser normalizes incomplete provider fields per market", () => {
  const request = parseAnalysisRequest({
    rawMatchData: "Partido de prueba",
    markets: [{
      id: "goals",
      name: "Goles totales",
      description: "",
      line: "1.5",
      baseCushion: 0.7,
      marketType: "totalGoals",
    }],
    rules: [{
      id: "goalkeeping",
      name: "Portería",
      instructions: "",
      riskFactor: 0.2,
      trigger: "goalkeeping",
    }, {
      id: "penalties",
      name: "Penales",
      instructions: "",
      riskFactor: 0.1,
      trigger: "penalties",
    }],
  });
  const verdict = {
    marketId: "goals",
    selection: null,
    projection: 2.3,
    probability: 0.65,
    rationale: "Proyección respaldada por los datos disponibles.",
    activeRuleIds: [],
    evidence: {
      confirmedStartingWingers: null,
      noStartingAttackerAbsences: true,
      bothGoalkeepersHighSavesAndGoalsPrevented: false,
      opponentConcedesPenalties: null,
      opponentBuildUpLosses: null,
    },
  };

  assert.equal(parseModelVerdicts({ verdicts: [verdict] }, request)[0].projection, 2.3);
  assert.equal(parseModelVerdicts({ verdicts: [verdict] }, request)[0].team, "both");
  assert.equal(parseModelVerdicts({ verdicts: [{ ...verdict, team: "home" }] }, request)[0].team, "home");
  assert.equal(parseModelVerdicts({ verdicts: [{ ...verdict, projection: null, probability: null }] }, request)[0].projection, null);
  const normalized = parseModelVerdicts({ extraMetadata: true, verdicts: [{
    ...verdict,
    selection: undefined,
    projection: "2.3",
    evidence: { confirmedStartingWingers: "unknown", unsupported: true },
    rationale: undefined,
    providerNote: "extra field",
  }] }, request)[0];
  assert.equal(normalized.selection, null);
  assert.equal(normalized.projection, null);
  assert.equal(normalized.evidence.confirmedStartingWingers, null);
  assert.equal(normalized.evidence.opponentBuildUpLosses, null);
  assert.equal(normalized.rationale, "El proveedor no incluyó una justificación válida.");
  assert.equal(parseModelVerdicts({ verdicts: [{ ...verdict, activeRuleIds: undefined }] }, request)[0].activeRuleIds, null);
  assert.equal(parseModelVerdicts({ verdicts: [{ ...verdict, activeRuleIds: ["not-selected"] }] }, request)[0].activeRuleIds, null);
  assert.equal(parseModelVerdicts({ verdicts: [{ ...verdict, activeRuleIds: ["goalkeeping", "goalkeeping"] }] }, request)[0].activeRuleIds, null);
  assert.equal(parseModelVerdicts({ verdicts: [verdict, verdict] }, request).length, 1);
  assert.deepEqual(parseModelVerdicts({ unexpectedWrapper: [] }, request), []);
  assert.equal(parseModelVerdicts(JSON.stringify({ verdicts: [verdict] }), request).length, 1);
});

test("duplicate rule IDs discard only that market and preserve a valid sibling", () => {
  const request = parseAnalysisRequest({
    rawMatchData: "Partido de prueba",
    markets: ["broken-market", "valid-market"].map((id) => ({
      id,
      name: "Mercado numérico",
      description: "",
      line: "1",
      baseCushion: 0.5,
    })),
    rules: [{
      id: "goalkeeping",
      name: "Portería",
      instructions: "",
      riskFactor: 0.2,
      trigger: "goalkeeping",
    }, {
      id: "penalties",
      name: "Penales",
      instructions: "",
      riskFactor: 0.1,
      trigger: "penalties",
    }],
  });
  const evidence = {
    confirmedStartingWingers: null,
    noStartingAttackerAbsences: null,
    bothGoalkeepersHighSavesAndGoalsPrevented: null,
    opponentConcedesPenalties: null,
    opponentBuildUpLosses: null,
  };
  const parsed = parseModelVerdicts({ verdicts: [
    {
      marketId: "broken-market",
      selection: null,
      projection: 2,
      probability: 0.7,
      rationale: "Proyección disponible.",
      activeRuleIds: ["goalkeeping", "goalkeeping"],
      evidence,
    },
    {
      marketId: "valid-market",
      selection: null,
      projection: 2,
      probability: 0.7,
      rationale: "Proyección disponible.",
      activeRuleIds: [],
      evidence,
    },
  ] }, request);

  const result = evaluateMarkets(request.markets, parsed, request.rules);

  assert.deepEqual(result.verdicts.map((verdict) => verdict.marketId), ["valid-market"]);
  assert.deepEqual(result.discardedMarkets.map((market) => market.marketId), ["broken-market"]);
  assert.match(result.discardedMarkets[0].reason, /lista válida de reglas/);
});

test("normalization removes excluded metrics from objects and arrays", () => {
  const result = parseNormalizedData({
    normalizedData: {
      "saques de banda": 4,
      "goal kicks": 2,
      offsides: 3,
      "passes in own half": 12,
      "goals by foot": 1,
      "shots hit the post": 1,
      corners: 8,
      metrics: { name: "Offside", count: 2 },
      events: [
        { metric: "saques de meta", count: 2 },
        { name: "foot goals", count: 1 },
        { label: "corners", count: 7 },
      ],
    },
  });

  assert.deepEqual(result, {
    corners: 8,
    events: [{ label: "corners", count: 7 }],
  });
});

test("normalization accepts wrapped or direct JSON objects from the provider", () => {
  const expected = { match: { fixture: "Juventus vs. Lazio" } };

  assert.deepEqual(
    parseNormalizedData({ normalizedData: expected, note: "provider metadata" }),
    expected,
  );
  assert.deepEqual(parseNormalizedData(expected), expected);
});

test("normalization accepts JSON objects encoded as strings", () => {
  const expected = { match: { fixture: "Juventus vs. Lazio" } };
  const encoded = JSON.stringify(expected);

  assert.deepEqual(parseNormalizedData(encoded), expected);
  assert.deepEqual(parseNormalizedData({ normalizedData: encoded }), expected);
});
