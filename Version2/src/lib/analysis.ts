export const MARKET_DEFINITIONS = [
  { id: "simple_win", name: "Victoria Simple", line: 0, metric: "adjusted_net_xg_difference", direction: "gte", baseCushion: 0.4 },
  { id: "double_chance", name: "Doble Oportunidad", line: 0, metric: "adjusted_net_xg_difference", direction: "gte", baseCushion: 0.15 },
  { id: "handicap_minus_one", name: "Hándicap -1.0", line: 1.1, metric: "expected_goal_difference", direction: "gte", baseCushion: null },
  { id: "corners_over_6_5", name: "Alta Córners 6.5", line: 6.5, metric: "corner_projection", direction: "gte", baseCushion: 3.5 },
  { id: "total_over_1_5", name: "Alta Total 1.5", line: 1.5, metric: "combined_expected_goals", direction: "gte", baseCushion: 1.2 },
  { id: "individual_over_0_5", name: "Alta Individual 0.5", line: 0.5, metric: "individual_expected_goals", direction: "gte", baseCushion: 0.8 },
] as const;

export type MarketId = (typeof MARKET_DEFINITIONS)[number]["id"];
export type Verdict = "SUBIR LÍNEA" | "APROBADO LÍNEA BASE" | "REDUCIR RIESGO" | "DESCARTADO POR VARIANZA";
export type MetricId =
  | "goals_for"
  | "goals_against"
  | "team_win_rate"
  | "team_draw_or_win_rate"
  | "adjusted_net_xg_difference"
  | "expected_goal_difference"
  | "corner_projection"
  | "combined_expected_goals"
  | "individual_expected_goals"
  | "goalkeeper_goals_prevented"
  | "opponent_duel_win_percent"
  | "opponent_clearances_percent"
  | "spine_status";

export type MetricEvidence = {
  status: "observed" | "derived" | "unavailable";
  value?: number;
  unit?: string;
  source?: string;
  formula?: string;
  reason?: string;
  sampleSize?: number;
  window?: string;
};

export type Rule = { metric: MetricId; operator: "gte" | "lte"; threshold: number };
export type MarketConfig = { enabled: boolean; baseCushion: number | null; rule: Rule | null };
export type RiskFactorId = "spine" | "goal_overs_under_four_days" | "keeper_goals_prevented" | "opponent_duels_and_clearances";
export type RiskSettings = Partial<Record<RiskFactorId, boolean>>;
export type RiskEvidence = Partial<Record<RiskFactorId, boolean | null>>;

export type MarketDecision = {
  marketId: MarketId;
  name: string;
  evaluation: "EVALUABLE" | "NOT_EVALUABLE";
  reason: string | null;
  verdict: Verdict | null;
  value: number | null;
  threshold: number | null;
  baseCushion: number | null;
  adjustedCushion: number | null;
  riskFactors: Array<{ id: RiskFactorId; label: string; modifier: number; state: "applied" | "clear" | "unavailable" }>;
};

export const RISK_MODIFIERS: Record<RiskFactorId, { label: string; modifier: number; markets: MarketId[] }> = {
  spine: { label: "Eje defensivo", modifier: 0.1, markets: MARKET_DEFINITIONS.map((market) => market.id) },
  goal_overs_under_four_days: { label: "Menos de 4 días: mercados de goles", modifier: 0.15, markets: ["total_over_1_5", "individual_over_0_5"] },
  keeper_goals_prevented: { label: "Portero: goles evitados > 2", modifier: 0.2, markets: ["handicap_minus_one", "individual_over_0_5"] },
  opponent_duels_and_clearances: { label: "Rival: duelos > 52% y despejes > 28%", modifier: 0.1, markets: ["simple_win"] },
};

export function marketRuleVersion(marketId: MarketId, config: MarketConfig, riskSettings: RiskSettings, riskEvidence: RiskEvidence = {}): string {
  const market = MARKET_DEFINITIONS.find((definition) => definition.id === marketId)!;
  const risks = (Object.entries(RISK_MODIFIERS) as Array<[RiskFactorId, (typeof RISK_MODIFIERS)[RiskFactorId]]>)
    .filter(([, definition]) => definition.markets.includes(marketId))
    .map(([id, definition]) => `${id}:${riskSettings[id] !== false ? "on" : "off"}:${definition.modifier}:${riskEvidence[id] ?? "unknown"}`)
    .join(",");
  return `market-v2:${marketId}:${config.enabled ? "enabled" : "disabled"}:${market.line}:${market.metric}:${market.direction}:${config.baseCushion ?? "unset"}:${risks}`;
}

export function evaluateMarket(input: {
  marketId: MarketId;
  config: MarketConfig | undefined;
  metrics: Partial<Record<MetricId, MetricEvidence>>;
  riskSettings?: RiskSettings;
  riskEvidence?: RiskEvidence;
}): MarketDecision {
  const definition = MARKET_DEFINITIONS.find((market) => market.id === input.marketId)!;
  const result = (reason: string): MarketDecision => ({
    marketId: definition.id,
    name: definition.name,
    evaluation: "NOT_EVALUABLE",
    reason,
    verdict: null,
    value: null,
    threshold: null,
    baseCushion: input.config?.baseCushion ?? null,
    adjustedCushion: null,
    riskFactors: [],
  });

  if (!input.config?.enabled) return result("Mercado desactivado en la configuración.");
  if (!input.config.rule) return result("Falta una regla de aprobación explícita.");
  if (input.config.baseCushion === null || !Number.isFinite(input.config.baseCushion) || input.config.baseCushion < 0) {
    return result("Falta configurar el colchón base de este mercado.");
  }

  const evidence = input.metrics[input.config.rule.metric];
  if (!evidence || evidence.status === "unavailable" || typeof evidence.value !== "number" || !Number.isFinite(evidence.value)) {
    return result(evidence?.reason ? `Falta un dato requerido: ${evidence.reason}` : "Falta un dato requerido para evaluar la regla.");
  }

  let riskSum = 0;
  const riskFactors: MarketDecision["riskFactors"] = [];
  for (const [id, definition] of Object.entries(RISK_MODIFIERS) as Array<[RiskFactorId, (typeof RISK_MODIFIERS)[RiskFactorId]]>) {
    if (!definition.markets.includes(input.marketId) || input.riskSettings?.[id] === false) continue;
    const state = input.riskEvidence?.[id];
    if (state === null || state === undefined) {
      riskFactors.push({ id, label: definition.label, modifier: definition.modifier, state: "unavailable" });
      return { ...result(`No evaluable: falta información del factor «${definition.label}».`), riskFactors };
    }
    if (state) riskSum += definition.modifier;
    riskFactors.push({ id, label: definition.label, modifier: definition.modifier, state: state ? "applied" : "clear" });
  }

  const { rule } = input.config;
  const threshold = rule.threshold;
  const margin = rule.operator === "gte" ? evidence.value - threshold : threshold - evidence.value;
  const adjustedCushion = input.config.baseCushion * (1 + riskSum);
  let verdict: Verdict;
  if (margin >= adjustedCushion * 1.3) verdict = "SUBIR LÍNEA";
  else if (margin >= adjustedCushion) verdict = "APROBADO LÍNEA BASE";
  else if (margin >= 0) verdict = "REDUCIR RIESGO";
  else verdict = "DESCARTADO POR VARIANZA";

  return {
    marketId: definition.id,
    name: definition.name,
    evaluation: "EVALUABLE",
    reason: null,
    verdict,
    value: evidence.value,
    threshold,
    baseCushion: input.config.baseCushion,
    adjustedCushion,
    riskFactors,
  };
}

export function canSaveApprovedPick(decision: Pick<MarketDecision, "evaluation" | "verdict">): boolean {
  return decision.evaluation === "EVALUABLE" && (decision.verdict === "SUBIR LÍNEA" || decision.verdict === "APROBADO LÍNEA BASE");
}

export type ParlaySelectionRef = { matchId: number; teamId: number; marketId: MarketId; selectionId: string };

export function areSelectionsContradictory(left: ParlaySelectionRef, right: ParlaySelectionRef): boolean {
  if (left.matchId !== right.matchId) return false;
  const outcomes: Partial<Record<MarketId, Record<string, Set<"home" | "draw" | "away">>>> = {
    simple_win: { home: new Set(["home"]), away: new Set(["away"]) },
    double_chance: { home_or_draw: new Set(["home", "draw"]), away_or_draw: new Set(["draw", "away"]) },
  };
  const leftOutcomes = outcomes[left.marketId]?.[left.selectionId];
  const rightOutcomes = outcomes[right.marketId]?.[right.selectionId];
  if (!leftOutcomes || !rightOutcomes) return false;
  return ![...leftOutcomes].some((outcome) => rightOutcomes.has(outcome));
}

export function parlayBlockReason(candidate: ParlaySelectionRef, selected: ParlaySelectionRef[]): string | null {
  if (selected.some((selection) => selection.teamId === candidate.teamId)) return "Equipo repetido";
  if (selected.some((selection) => areSelectionsContradictory(candidate, selection))) return "Selecciones contradictorias";
  if (selected.length >= 4) return "Máximo de cuatro equipos";
  return null;
}

export type Fixture = { season: number; kickoff: string; status: string };

export function filterUpcomingFixtures<T extends Fixture>(fixtures: T[], season: number, now: Date): T[] {
  return fixtures
    .filter((fixture) => fixture.season === season && Date.parse(fixture.kickoff) >= now.getTime())
    .filter((fixture) => !["IN_PLAY", "PAUSED", "FINISHED", "SUSPENDED", "CANCELLED", "POSTPONED"].includes(fixture.status))
    .sort((left, right) => Date.parse(left.kickoff) - Date.parse(right.kickoff));
}

export function evaluateDecision(input: Parameters<typeof evaluateMarket>[0]): MarketDecision {
  const definition = MARKET_DEFINITIONS.find((market) => market.id === input.marketId)!;
  const rule = { metric: definition.metric, operator: definition.direction, threshold: definition.line };
  return evaluateMarket({ ...input, config: input.config ? { ...input.config, rule } : undefined });
}