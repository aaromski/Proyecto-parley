import type {
  ActiveRuleMetadata,
  AnalysisResponse,
  ForecastDecisionKind,
  ForecastEvidence,
  ForecastType,
  Market,
  ParsedModelVerdict,
  Rule,
} from "@/lib/analysis-contract";

export const FORECAST_POLICY = {
  minimumCategoricalProbability: 0.55,
  underCushionRatio: 2 / 3.5,
  corners: {
    overCushion: 3.5,
    underCushion: 2,
    minimumToMaintain: 10,
    maximumToMaintain: 10.5,
    minimumToUpgrade: 12,
    higherUpgradeAt: 13,
    upgradeLine: 8.5,
    higherUpgradeLine: 9.5,
  },
  totalGoals: {
    overCushion: 0.7,
    underCushion: 0.5,
    minimumToMaintain: 2.2,
    maximumToMaintain: 2.35,
    minimumToUpgrade: 3.2,
    upgradeLineIncrement: 1,
  },
  teamGoals: {
    overCushion: 0.6,
    underCushion: 0.35,
    minimumToMaintain: 1.1,
    maximumToMaintain: 1.25,
    minimumToUpgrade: 1.85,
    opponentBuildUpLosses: 110,
    upgradeLineIncrement: 1,
  },
} as const;

export type ForecastDecision =
  | { selection: string; decision: ForecastDecisionKind }
  | { decision: "discarded"; reason: string };

type DirectionalDecision =
  | { kind: "approved"; selection: string; decision: "maintained" | "upgraded" }
  | { kind: "blocked"; reason: string }
  | { kind: "open" };

function lineValue(line: string): number | null {
  const match = line.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function overSelection(line: number): string {
  return `Over ${Number.isInteger(line) ? line.toFixed(1) : line}`;
}

function directionalSelection(line: number, forecastType: Extract<ForecastType, "over" | "under">): string {
  const formattedLine = Number.isInteger(line) ? line.toFixed(1) : String(line);
  return `${forecastType === "under" ? "Under" : "Over"} ${formattedLine}`;
}

function hasGoalkeeperDiscardRisk(evidence: ForecastEvidence): boolean {
  return evidence.bothGoalkeepersHighSavesAndGoalsPrevented === true;
}

function policyFor(market: Market) {
  if (market.marketType === "corners") return FORECAST_POLICY.corners;
  if (market.marketType === "totalGoals") return FORECAST_POLICY.totalGoals;
  if (market.marketType === "teamGoals") return FORECAST_POLICY.teamGoals;
  return null;
}

function pairCushions(market: Market, adjustedCushion: number): { over: number; under: number } {
  const policy = policyFor(market);
  const factor = market.baseCushion > 0 ? adjustedCushion / market.baseCushion : 1;
  if (policy) {
    return {
      over: market.forecastType === "over" ? adjustedCushion : policy.overCushion * factor,
      under: market.forecastType === "under" ? adjustedCushion : policy.underCushion * factor,
    };
  }
  if (market.forecastType === "over") {
    return { over: adjustedCushion, under: adjustedCushion * FORECAST_POLICY.underCushionRatio };
  }
  return {
    over: adjustedCushion / FORECAST_POLICY.underCushionRatio,
    under: adjustedCushion,
  };
}

function deadZoneReason(
  projection: number,
  baseLine: number,
  underCeiling: number,
  overFloor: number,
): string {
  return `Zona muerta: la proyección (${projection}) queda entre el umbral Under (${underCeiling}) y el umbral Over (${overFloor}) respecto a la línea ${baseLine}, en una zona de alta incertidumbre/equilibrio.`;
}

function evaluateOverSide(
  market: Market,
  forecast: ParsedModelVerdict,
  projection: number,
  baseLine: number,
  overCushion: number,
): DirectionalDecision {
  const minimumToMaintain = baseLine + overCushion;
  const minimumToUpgrade = baseLine + overCushion * 2;

  if (market.marketType === "corners") {
    const policy = FORECAST_POLICY.corners;
    const cushionDelta = overCushion - policy.overCushion;
    if (
      projection >= policy.minimumToUpgrade + cushionDelta &&
      forecast.evidence.confirmedStartingWingers === true
    ) {
      return {
        kind: "approved",
        selection: overSelection(
          projection >= policy.higherUpgradeAt ? policy.higherUpgradeLine : policy.upgradeLine,
        ),
        decision: "upgraded",
      };
    }
    if (
      projection >= Math.max(policy.minimumToMaintain + cushionDelta, minimumToMaintain) &&
      projection <= policy.maximumToMaintain + cushionDelta
    ) {
      return { kind: "approved", selection: overSelection(baseLine), decision: "maintained" };
    }
    if (projection >= policy.minimumToUpgrade + cushionDelta && forecast.evidence.confirmedStartingWingers !== true) {
      return {
        kind: "blocked",
        reason: "No se confirmaron extremos titulares para autorizar el escalado y la proyección no alcanza mantenimiento.",
      };
    }
    return { kind: "open" };
  }

  if (market.marketType === "totalGoals") {
    const policy = FORECAST_POLICY.totalGoals;
    const cushionDelta = overCushion - policy.overCushion;
    if (hasGoalkeeperDiscardRisk(forecast.evidence)) {
      return {
        kind: "blocked",
        reason: "Filtro de riesgo: ambos porteros presentan paradas elevadas y goles evitados superiores a +2.0.",
      };
    }
    if (
      projection >= Math.max(policy.minimumToUpgrade + cushionDelta, minimumToUpgrade) &&
      forecast.evidence.noStartingAttackerAbsences === true &&
      forecast.evidence.bothGoalkeepersHighSavesAndGoalsPrevented === false
    ) {
      return {
        kind: "approved",
        selection: overSelection(baseLine + policy.upgradeLineIncrement),
        decision: "upgraded",
      };
    }
    if (
      projection >= Math.max(policy.minimumToMaintain + cushionDelta, minimumToMaintain) &&
      projection <= policy.maximumToMaintain + cushionDelta
    ) {
      return { kind: "approved", selection: overSelection(baseLine), decision: "maintained" };
    }
    if (forecast.evidence.noStartingAttackerAbsences !== true && projection >= policy.minimumToUpgrade) {
      return {
        kind: "blocked",
        reason: "No se confirmó la ausencia de bajas atacantes titulares para autorizar el escalado.",
      };
    }
    return { kind: "open" };
  }

  if (market.marketType === "teamGoals") {
    const policy = FORECAST_POLICY.teamGoals;
    const cushionDelta = overCushion - policy.overCushion;
    const opponentCondition =
      forecast.evidence.opponentConcedesPenalties === true ||
      (forecast.evidence.opponentBuildUpLosses !== null &&
        forecast.evidence.opponentBuildUpLosses > policy.opponentBuildUpLosses);
    if (
      projection >= Math.max(policy.minimumToUpgrade + cushionDelta, minimumToUpgrade) &&
      opponentCondition
    ) {
      return {
        kind: "approved",
        selection: overSelection(baseLine + policy.upgradeLineIncrement),
        decision: "upgraded",
      };
    }
    if (
      projection >= Math.max(policy.minimumToMaintain + cushionDelta, minimumToMaintain) &&
      projection <= policy.maximumToMaintain + cushionDelta
    ) {
      return { kind: "approved", selection: overSelection(baseLine), decision: "maintained" };
    }
    if (projection >= policy.minimumToUpgrade && !opponentCondition) {
      return {
        kind: "blocked",
        reason: "No se confirmó que el rival conceda penales o supere 110 pérdidas en salida para autorizar el escalado.",
      };
    }
    return { kind: "open" };
  }

  if (projection >= minimumToMaintain) {
    return {
      kind: "approved",
      selection: directionalSelection(baseLine, "over"),
      decision: "maintained",
    };
  }
  return { kind: "open" };
}

function evaluateUnderSide(projection: number, baseLine: number, underCushion: number): DirectionalDecision {
  const maximumToMaintain = baseLine - underCushion;
  if (projection <= maximumToMaintain) {
    return {
      kind: "approved",
      selection: directionalSelection(baseLine, "under"),
      decision: "maintained",
    };
  }
  return { kind: "open" };
}

export function decideForecast(
  market: Market,
  forecast: ParsedModelVerdict,
  adjustedCushion: number,
): ForecastDecision {
  if (market.forecastType === "moneyline" || market.forecastType === "handicap") {
    if (!forecast.selection) {
      return {
        decision: "discarded",
        reason: `No se recibió una selección candidata para el mercado ${market.forecastType === "moneyline" ? "de resultado" : "de hándicap"}.`,
      };
    }
    if (forecast.probability === null || forecast.probability < FORECAST_POLICY.minimumCategoricalProbability) {
      return {
        decision: "discarded",
        reason: `La probabilidad no alcanza el mínimo de ${Math.round(FORECAST_POLICY.minimumCategoricalProbability * 100)}% para aprobar este mercado.`,
      };
    }
    return { selection: forecast.selection, decision: "maintained" };
  }

  if (forecast.projection === null) {
    return { decision: "discarded", reason: "No se recibió una proyección numérica para este mercado." };
  }
  const baseLine = lineValue(market.line);
  if (baseLine === null) {
    return { decision: "discarded", reason: "La línea debe ser numérica para comparar la proyección." };
  }

  const projection = forecast.projection;
  const cushions = pairCushions(market, adjustedCushion);
  const overFloor = baseLine + cushions.over;
  const underCeiling = baseLine - cushions.under;
  const overSide = evaluateOverSide(market, forecast, projection, baseLine, cushions.over);
  const underSide = evaluateUnderSide(projection, baseLine, cushions.under);

  if (market.forecastType === "over") {
    if (overSide.kind === "approved") {
      return { selection: overSide.selection, decision: overSide.decision };
    }
    if (underSide.kind === "approved") {
      return { selection: underSide.selection, decision: "inverted_suggestion" };
    }
    if (overSide.kind === "blocked") {
      return { decision: "discarded", reason: overSide.reason };
    }
    return {
      decision: "discarded",
      reason: deadZoneReason(projection, baseLine, underCeiling, overFloor),
    };
  }

  if (underSide.kind === "approved") {
    return { selection: underSide.selection, decision: underSide.decision };
  }
  if (overSide.kind === "approved") {
    return { selection: overSide.selection, decision: "inverted_suggestion" };
  }
  if (overSide.kind === "blocked") {
    return { decision: "discarded", reason: overSide.reason };
  }
  return {
    decision: "discarded",
    reason: deadZoneReason(projection, baseLine, underCeiling, overFloor),
  };
}

export function evaluateMarkets(
  markets: Market[],
  forecasts: ParsedModelVerdict[],
  rules: Rule[],
): Pick<AnalysisResponse, "verdicts" | "discardedMarkets"> {
  const forecastsById = new Map(forecasts.map((forecast) => [forecast.marketId, forecast] as const));
  const rulesById = new Map(rules.map((rule) => [rule.id, rule] as const));
  const verdicts: AnalysisResponse["verdicts"] = [];
  const discardedMarkets: AnalysisResponse["discardedMarkets"] = [];

  for (const market of markets) {
    const forecast = forecastsById.get(market.id);
    const isCategorical = market.forecastType === "moneyline" || market.forecastType === "handicap";
    if (
      !forecast ||
      forecast.activeRuleIds === null ||
      forecast.probability === null ||
      (isCategorical ? forecast.selection === null : forecast.projection === null)
    ) {
      discardedMarkets.push({
        marketId: market.id,
        projection: forecast?.projection ?? null,
        reason: !forecast
          ? "El proveedor no devolvió una evaluación para este mercado."
          : forecast.activeRuleIds === null
            ? "El proveedor no devolvió una lista válida de reglas aplicables; no se puede calcular el colchón ajustado."
          : isCategorical && forecast.selection === null
            ? "El proveedor no devolvió una selección candidata para este mercado."
            : isCategorical
              ? "El proveedor no devolvió una probabilidad válida para la selección candidata."
              : forecast.projection === null
                ? "No hay datos suficientes para calcular una proyección numérica."
                : "No hay datos suficientes para calcular una probabilidad válida.",
      });
      continue;
    }

    const riskSum = forecast.activeRuleIds.reduce(
      (sum, id) => sum + rulesById.get(id)!.riskFactor,
      0,
    );
    const adjustedCushion = market.baseCushion * (1 + riskSum);
    const decision = decideForecast(market, forecast, adjustedCushion);
    if (decision.decision === "discarded") {
      discardedMarkets.push({
        marketId: market.id,
        projection: forecast.projection,
        reason: decision.reason,
      });
      continue;
    }

    const activeRules: ActiveRuleMetadata[] = forecast.activeRuleIds.map((id) => {
      const rule = rulesById.get(id)!;
      return { id: rule.id, name: rule.name, trigger: rule.trigger, riskFactor: rule.riskFactor };
    });
    verdicts.push({
      marketId: market.id,
      selection: decision.selection,
      projection: forecast.projection,
      forecastDecision: decision.decision,
      probability: forecast.probability,
      rationale: forecast.rationale,
      activeRuleIds: forecast.activeRuleIds,
      riskSum,
      baseCushion: market.baseCushion,
      adjustedCushion,
      team: forecast.team,
      activeRules,
    });
  }

  verdicts.sort((left, right) => right.probability - left.probability);
  return { verdicts, discardedMarkets };
}
