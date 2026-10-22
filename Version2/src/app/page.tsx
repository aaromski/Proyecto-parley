"use client";

import { useEffect, useState } from "react";
import {
  canSaveApprovedPick,
  evaluateDecision,
  MARKET_DEFINITIONS,
  parlayBlockReason as getParlayBlockReason,
  RISK_MODIFIERS,
  type MarketConfig,
  type MarketDecision,
  type MarketId,
  type MetricEvidence,
  type MetricId,
  type RiskEvidence,
  type RiskFactorId,
  type RiskSettings,
} from "@/lib/analysis";
import {
  clearSlip,
  readSlip,
  removeSlipSelection,
  saveApprovedPick,
  type SlipSelection,
} from "@/lib/slip-store";
import type { MatchDetail, MatchSummary, MetricAvailability, TeamComparison } from "@/lib/server/football";

type View = "matches" | "slip" | "settings";
type Window = "season" | "recent";
type TeamSide = "home" | "away";
type MatchListResponse = { matches: MatchSummary[]; coverage: "available" | "unknown" | "unavailable"; season: number };
type DetailResponse = { match: MatchDetail; metrics: MatchDetail["metrics"]; teamComparisons: MatchDetail["teamComparisons"] };
type Preferences = { markets: Record<MarketId, MarketConfig>; riskSettings: RiskSettings };
type ApiErrorBody = { error?: { message?: string; retryable?: boolean } };
type Explanation = { statements: Array<{ evidenceId: string; text: string }>; limitations: string[] };

const PREFERENCES_KEY = "football-analysis-preferences-v1";
const METRIC_LABELS: Record<MetricId, string> = {
  goals_for: "Goles a favor por partido",
  goals_against: "Goles en contra por partido",
  adjusted_net_xg_difference: "Diferencial de xG neto ajustado",
  expected_goal_difference: "Diferencial xG",
  corner_projection: "Proyección de córners",
  combined_expected_goals: "xG combinado",
  individual_expected_goals: "xG individual",
  goalkeeper_goals_prevented: "Goles evitados por el portero",
  opponent_duel_win_percent: "Duelos ganados por el rival",
  opponent_clearances_percent: "Despejes del rival",
  spine_status: "Eje defensivo",
  team_win_rate: "Victorias del equipo",
  team_draw_or_win_rate: "Victorias o empates del equipo",
};
const METRIC_UNAVAILABLE: MetricEvidence = { status: "unavailable", reason: "La fuente no proporciona esta métrica." };

function defaultPreferences(): Preferences {
  return {
    markets: Object.fromEntries(MARKET_DEFINITIONS.map((market) => [market.id, { enabled: true, baseCushion: market.baseCushion, rule: null }])) as Record<MarketId, MarketConfig>,
    riskSettings: Object.fromEntries(Object.keys(RISK_MODIFIERS).map((id) => [id, true])) as RiskSettings,
  };
}

function readPreferences(): Preferences {
  const defaults = defaultPreferences();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return defaults;
    const stored = parsed as { markets?: Record<string, unknown>; riskSettings?: Record<string, unknown> };
    const markets = { ...defaults.markets };
    for (const market of MARKET_DEFINITIONS) {
      const value = stored.markets?.[market.id];
      if (!value || typeof value !== "object") continue;
      const candidate = value as { enabled?: unknown; baseCushion?: unknown };
      const baseCushion = typeof candidate.baseCushion === "number" && Number.isFinite(candidate.baseCushion) && candidate.baseCushion >= 0
        ? candidate.baseCushion
        : market.baseCushion;
      markets[market.id] = { enabled: candidate.enabled !== false, baseCushion, rule: null };
    }
    const riskSettings = { ...defaults.riskSettings };
    for (const id of Object.keys(RISK_MODIFIERS) as RiskFactorId[]) {
      if (typeof stored.riskSettings?.[id] === "boolean") riskSettings[id] = stored.riskSettings[id] as boolean;
    }
    return { markets, riskSettings };
  } catch {
    return defaults;
  }
}

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toMetricEvidence(metric: MetricAvailability | undefined): MetricEvidence {
  if (!metric || metric.status === "unavailable") {
    const reason = metric?.reason === "insufficient_data"
      ? "La muestra está incompleta."
      : metric?.reason === "not_covered"
        ? "La fuente no tiene cobertura para esta ventana."
        : "La fuente no proporciona esta métrica.";
    return { status: "unavailable", reason };
  }
  return {
    status: metric.status,
    value: metric.value,
    unit: metric.unit,
    formula: metric.status === "derived" ? metric.formula : undefined,
    sampleSize: metric.status === "derived" ? metric.sampleSize : undefined,
    window: metric.status === "derived" ? metric.window : undefined,
  };
}

function metricValue(metric: MetricEvidence): string {
  if (metric.status === "unavailable" || typeof metric.value !== "number") return "No disponible";
  const value = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(metric.value);
  return `${value}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function matchTime(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "Fecha no disponible";
  return `${new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date)} (${timeZone})`;
}

async function readApiResponse<T>(response: Response): Promise<T> {
  let body: T & ApiErrorBody;
  try {
    body = await response.json() as T & ApiErrorBody;
  } catch {
    throw new Error("El servidor devolvió una respuesta no válida.");
  }
  if (!response.ok) throw new Error(body.error?.message ?? "No se pudo completar la solicitud.");
  return body;
}

async function fetchFixtures(season: number, date: string, query: string): Promise<MatchListResponse> {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 13);
  to.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({ season: String(season), from: from.toISOString(), to: to.toISOString() });
  if (query.trim()) params.set("q", query.trim());
  const response = await fetch(`/api/matches?${params.toString()}`, { cache: "no-store" });
  return readApiResponse<MatchListResponse>(response);
}

function ComparisonColumn({ comparison, window, other, side, timeZone }: {
  comparison: TeamComparison;
  window: Window;
  other: TeamComparison;
  side: TeamSide;
  timeZone: string;
}) {
  const stats = comparison[window];
  const otherStats = other[window];
  const metricRows: Array<{ id: "goalsFor" | "goalsAgainst"; label: string }> = [
    { id: "goalsFor", label: "Goles a favor" },
    { id: "goalsAgainst", label: "Goles en contra" },
  ];
  return (
    <section className="team-column" aria-label={`Comparación de ${comparison.teamName}`}>
      <h3>{comparison.teamName}</h3>
      <p className="metric-note">{stats.sampleSize} partidos · {stats.window}</p>
      {metricRows.map(({ id, label }) => {
        const value = stats[id];
        const otherValue = otherStats[id];
        const max = Math.max(value.status === "unavailable" ? 0 : value.value, otherValue.status === "unavailable" ? 0 : otherValue.value, 0);
        const width = value.status === "unavailable" || max === 0 ? 0 : Math.max(0, Math.min(100, (value.value / max) * 100));
        const unit = value.status === "unavailable" ? "" : value.unit;
        return (
          <div className="metric-line" key={id}>
            <span className="metric-label">{label}</span>
            <span className="metric-value">{metricValue(toMetricEvidence(value))}</span>
            {value.status !== "unavailable" && <div className="metric-bar" aria-hidden="true"><div className={`metric-fill ${side}`} style={{ width: `${width}%` }} /></div>}
            <span className="metric-note">
              {value.status === "unavailable"
                ? value.reason === "insufficient_data" ? "No disponible: muestra incompleta" : "No disponible en la fuente consultada"
                : `Derivado · ${unit} · ${value.formula}`}
            </span>
          </div>
        );
      })}
      <h3 className="section-title">Resultados históricos disponibles</h3>
      {comparison.results.length ? (
        <ul className="history-list">
          {comparison.results.slice(-8).reverse().map((result) => (
            <li className="history-row" key={result.id}>
              <span>{matchTime(result.kickoff, timeZone).replace(` (${timeZone})`, "")} · vs. {result.opponent}</span>
              <span className="history-score">{result.goalsFor}-{result.goalsAgainst} · {result.outcome}</span>
            </li>
          ))}
        </ul>
      ) : <p className="metric-note">No hay resultados históricos completos disponibles.</p>}
      {comparison.results.length > 8 && <p className="metric-note">Se muestran 8 de {comparison.results.length} resultados recibidos.</p>}
    </section>
  );
}

export default function HomePage() {
  const [view, setView] = useState<View>("matches");
  const [timeZone, setTimeZone] = useState("UTC");
  const [today, setToday] = useState("");
  const [season, setSeason] = useState(2026);
  const [searchDate, setSearchDate] = useState("");
  const [query, setQuery] = useState("");
  const [fixtures, setFixtures] = useState<MatchSummary[]>([]);
  const [coverage, setCoverage] = useState<MatchListResponse["coverage"]>("unknown");
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState("");
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);
  const [match, setMatch] = useState<MatchDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [comparisonWindow, setWindow] = useState<Window>("season");
  const [comparisonSide, setComparisonSide] = useState<TeamSide>("home");
  const [marketSides, setMarketSides] = useState<Record<MarketId, TeamSide>>(
    Object.fromEntries(MARKET_DEFINITIONS.map(({ id }) => [id, "home"])) as Record<MarketId, TeamSide>,
  );
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [slip, setSlip] = useState<SlipSelection[]>([]);
  const [storageMessage, setStorageMessage] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [explanationError, setExplanationError] = useState("");
  const [parlayIds, setParlayIds] = useState<string[]>([]);
  const [parlayExplanation, setParlayExplanation] = useState<Explanation | null>(null);
  const [parlayLoading, setParlayLoading] = useState(false);
  const [parlayError, setParlayError] = useState("");

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const currentDate = localDateString();
    setTimeZone(zone);
    setToday(currentDate);
    setSearchDate(currentDate);
    let active = true;
    setMatchesLoading(true);
    fetchFixtures(2026, currentDate, "")
      .then((result) => {
        if (!active) return;
        setFixtures(result.matches);
        setCoverage(result.coverage);
      })
      .catch((error: unknown) => {
        if (active) setMatchesError(error instanceof Error ? error.message : "No se pudo consultar el calendario.");
      })
      .finally(() => { if (active) setMatchesLoading(false); });
    try {
      const loadedPreferences = readPreferences();
      setPreferences(loadedPreferences);
      const loadedSlip = readSlip(localStorage);
      setSlip(loadedSlip.selections);
      if (loadedSlip.invalid) setStorageMessage("No se pudo recuperar el Slip local: los datos guardados no son válidos o el almacenamiento no está disponible.");
    } catch {
      setStorageMessage("No se pudo recuperar la configuración local; los cambios de esta sesión seguirán visibles.");
    }
    setStorageReady(true);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (selectedMatchId === null) {
      setMatch(null);
      setDetailError("");
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    setExplanation(null);
    setExplanationError("");
    fetch(`/api/matches/${selectedMatchId}`, { cache: "no-store", signal: controller.signal })
      .then((response) => readApiResponse<DetailResponse>(response))
      .then((result) => setMatch(result.match))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "No se pudo cargar el análisis.");
      })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedMatchId]);

  function persistPreferences(next: Preferences) {
    setPreferences(next);
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
      setStorageMessage("");
    } catch {
      setStorageMessage("No se pudo confirmar el guardado en este dispositivo. Tus cambios siguen visibles en esta sesión; vuelve a intentarlo.");
    }
  }

  async function submitSearch(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!searchDate) return;
    setMatchesLoading(true);
    setMatchesError("");
    try {
      const result = await fetchFixtures(season, searchDate, query);
      setFixtures(result.matches);
      setCoverage(result.coverage);
    } catch (error) {
      setMatchesError(error instanceof Error ? error.message : "No se pudo consultar el calendario.");
    } finally {
      setMatchesLoading(false);
    }
  }

  async function shiftSearchDate(days: number) {
    if (!searchDate) return;
    const nextDate = new Date(`${searchDate}T12:00:00`);
    nextDate.setDate(nextDate.getDate() + days);
    const value = localDateString(nextDate);
    if (today && value < today) return;
    setSearchDate(value);
    setMatchesLoading(true);
    setMatchesError("");
    try {
      const result = await fetchFixtures(season, value, query);
      setFixtures(result.matches);
      setCoverage(result.coverage);
    } catch (error) {
      setMatchesError(error instanceof Error ? error.message : "No se pudo consultar el calendario.");
    } finally {
      setMatchesLoading(false);
    }
  }

  function metricsFor(side: TeamSide): Partial<Record<MetricId, MetricEvidence>> {
    if (!match) return {};
    const comparison = match.teamComparisons[side];
    const stats = comparison[comparisonWindow];
    return {
      goals_for: toMetricEvidence(stats.goalsFor),
      goals_against: toMetricEvidence(stats.goalsAgainst),
      adjusted_net_xg_difference: METRIC_UNAVAILABLE,
      expected_goal_difference: METRIC_UNAVAILABLE,
      corner_projection: METRIC_UNAVAILABLE,
      combined_expected_goals: METRIC_UNAVAILABLE,
      individual_expected_goals: METRIC_UNAVAILABLE,
      goalkeeper_goals_prevented: METRIC_UNAVAILABLE,
      opponent_duel_win_percent: METRIC_UNAVAILABLE,
      opponent_clearances_percent: METRIC_UNAVAILABLE,
      spine_status: METRIC_UNAVAILABLE,
    };
  }

  function riskEvidence(): RiskEvidence {
    if (!match) return {};
    const timeUntilKickoff = Date.parse(match.kickoff) - Date.now();
    return {
      spine: null,
      goal_overs_under_four_days: timeUntilKickoff >= 0 ? timeUntilKickoff < 4 * 24 * 60 * 60 * 1000 : null,
      keeper_goals_prevented: null,
      opponent_duels_and_clearances: null,
    };
  }

  function decisionFor(marketId: MarketId): MarketDecision {
    const side = marketSides[marketId];
    const decision = evaluateDecision({
      marketId,
      config: preferences.markets[marketId],
      metrics: metricsFor(side),
      riskSettings: preferences.riskSettings,
      riskEvidence: riskEvidence(),
    });
    if (!match) return decision;
    const future = Date.parse(match.kickoff) > Date.now() && !["IN_PLAY", "PAUSED", "FINISHED", "SUSPENDED", "CANCELLED", "POSTPONED"].includes(match.status);
    if (!future) return { ...decision, evaluation: "NOT_EVALUABLE", reason: "El encuentro ya empezó o no es un partido futuro.", verdict: null };
    return decision;
  }

  function saveSelection(marketId: MarketId, decision: MarketDecision) {
    if (!match || !canSaveApprovedPick(decision)) return;
    const side = marketSides[marketId];
    const team = match[side === "home" ? "homeTeam" : "awayTeam"];
    const opponent = match[side === "home" ? "awayTeam" : "homeTeam"];
    const selectionId = marketId === "double_chance" ? `${side}_or_draw` : marketId === "simple_win" ? side : marketId === "individual_over_0_5" ? side : "match";
    const selection: SlipSelection = {
      id: `${match.id}-${marketId}-${selectionId}`,
      matchId: match.id,
      season: match.season,
      teamId: team.id,
      teamName: team.name,
      opponentName: opponent.name,
      kickoff: match.kickoff,
      competitionName: match.competition?.name ?? "Competición no disponible",
      marketId,
      marketName: MARKET_DEFINITIONS.find((market) => market.id === marketId)!.name,
      selectionId,
      verdict: decision.verdict as SlipSelection["verdict"],
      ruleVersion: "regla-local-configurada-v1",
      savedAt: new Date().toISOString(),
    };
    if (!storageReady) return;
    try {
      setSlip(saveApprovedPick(localStorage, selection, decision));
      setStorageMessage("");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("formato válido")) {
        setSlip((current) => current.some((saved) => saved.id === selection.id) ? current : [...current, selection]);
        setStorageMessage("No se pudo confirmar el guardado en este dispositivo. Tus cambios siguen visibles en esta sesión; vuelve a intentarlo.");
      } else {
        setStorageMessage("El Slip guardado tiene un formato inválido y no se modificó.");
      }
    }
  }

  function removeSelection(id: string) {
    try {
      setSlip(removeSlipSelection(localStorage, id));
      setStorageMessage("");
    } catch {
      setSlip((current) => current.filter((selection) => selection.id !== id));
      setStorageMessage("No se pudo confirmar el guardado en este dispositivo. Tus cambios siguen visibles en esta sesión; vuelve a intentarlo.");
    }
    setParlayIds((current) => current.filter((selectionId) => selectionId !== id));
  }

  function emptySlip() {
    if (!globalThis.confirm("¿Quieres vaciar todas las selecciones del Slip?")) return;
    try {
      clearSlip(localStorage);
      setSlip([]);
      setParlayIds([]);
      setStorageMessage("");
    } catch {
      setSlip([]);
      setParlayIds([]);
      setStorageMessage("No se pudo confirmar el guardado en este dispositivo. Tus cambios siguen visibles en esta sesión; vuelve a intentarlo.");
    }
  }

  async function requestMatchExplanation() {
    if (!match) return;
    setExplanationLoading(true);
    setExplanationError("");
    setExplanation(null);
    try {
      const response = await fetch("/api/analysis/explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: match.id, window: comparisonWindow }),
      });
      const result = await readApiResponse<{ explanation: Explanation; decision: null }>(response);
      setExplanation(result.explanation);
    } catch (error) {
      setExplanationError(error instanceof Error ? error.message : "No se pudo generar la explicación.");
    } finally {
      setExplanationLoading(false);
    }
  }

  async function requestParlayExplanation() {
    const selected = slip.filter((selection) => parlayIds.includes(selection.id));
    if (!selected.length) return;
    setParlayLoading(true);
    setParlayError("");
    setParlayExplanation(null);
    try {
      const response = await fetch("/api/parlays/explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: selected.map(({ matchId, marketId, selectionId }) => ({ matchId, marketId, selectionId })) }),
      });
      const result = await readApiResponse<{ explanation: Explanation }>(response);
      setParlayExplanation(result.explanation);
    } catch (error) {
      setParlayError(error instanceof Error ? error.message : "El servidor no confirmó selecciones aprobadas.");
    } finally {
      setParlayLoading(false);
    }
  }

  const renderMarket = (marketId: MarketId) => {
    const definition = MARKET_DEFINITIONS.find((market) => market.id === marketId)!;
    const decision = decisionFor(marketId);
    const metric = metricsFor(marketSides[marketId])[definition.metric];
    const threshold = definition.line + (preferences.markets[marketId].baseCushion ?? 0);
    const ruleLabel = `${METRIC_LABELS[definition.metric]} ≥ ${threshold.toLocaleString("es-ES", { maximumFractionDigits: 2 })} (línea ${definition.line.toLocaleString("es-ES", { maximumFractionDigits: 2 })} + colchón)`;
    const riskInfo = riskEvidence();
    const selectionLabel = marketId === "double_chance"
      ? marketSides[marketId] === "home" ? "Local o empate" : "Visitante o empate"
      : marketId === "simple_win" ? `Victoria ${marketSides[marketId] === "home" ? "local" : "visitante"}`
        : marketId === "individual_over_0_5" ? `Equipo: ${match?.[marketSides[marketId] === "home" ? "homeTeam" : "awayTeam"].name ?? "No disponible"}`
          : "Partido";
    return (
      <article className="market-item" key={marketId}>
        <div className="market-heading">
          <h3>{definition.name}</h3>
          <span className={`status-badge ${decision.evaluation === "NOT_EVALUABLE" ? "not-evaluable" : ""}`}>
            {decision.evaluation === "NOT_EVALUABLE" ? "No evaluable" : "Evaluable"}
          </span>
        </div>
        <p className="market-meta">
          <span><strong>Selección:</strong> {selectionLabel}</span>
          <span><strong>Regla:</strong> {ruleLabel}</span>
          {metric && <span><strong>{metric.status === "derived" ? "Derivado" : metric.status === "observed" ? "Observado" : "Dato"}:</strong> {metricValue(metric)}{metric.sampleSize ? ` · ${metric.sampleSize} partidos · ${metric.window}` : ""}</span>}
          {decision.reason && <span><strong>Motivo:</strong> {decision.reason}</span>}
          {decision.verdict && <span><strong>Colchón ajustado:</strong> {decision.adjustedCushion?.toLocaleString("es-ES", { maximumFractionDigits: 3 })} · {decision.verdict}</span>}
        </p>
        {marketId === "individual_over_0_5" && (
          <div className="field market-control-wide">
            <label htmlFor="individual-team">Equipo del mercado</label>
            <select id="individual-team" value={marketSides[marketId]} onChange={(event) => setMarketSides((current) => ({ ...current, [marketId]: event.target.value as TeamSide }))}>
              <option value="home">{match?.homeTeam.name ?? "Local"}</option>
              <option value="away">{match?.awayTeam.name ?? "Visitante"}</option>
            </select>
          </div>
        )}
        <ul className="risk-list" aria-label={`Factores de riesgo para ${definition.name}`}>
          {(Object.entries(RISK_MODIFIERS) as Array<[RiskFactorId, (typeof RISK_MODIFIERS)[RiskFactorId]]>)
            .filter(([, risk]) => risk.markets.includes(marketId))
            .map(([id, risk]) => {
              const state = riskInfo[id];
              const enabled = preferences.riskSettings[id] !== false;
              const message = !enabled ? "Desactivado en Ajustes" : state === null || state === undefined
                ? `No disponible · si se activa, suma ${Math.round(risk.modifier * 100)}% y bloquea la evaluación hasta disponer del dato`
                : state ? `Activado · suma ${Math.round(risk.modifier * 100)}% al colchón` : "No activado con la evidencia actual";
              return <li key={id}>{risk.label}: {message}</li>;
            })}
        </ul>
        <p className="metric-note">Fórmula: colchón base × (1 + suma de factores activados). «Subir línea» requiere superar el colchón ajustado en 30%.</p>
        <div className="market-actions">
          <button className="button small" type="button" disabled={!canSaveApprovedPick(decision)} onClick={() => saveSelection(marketId, decision)}>Guardar en Slip</button>
          {!canSaveApprovedPick(decision) && <span className="disabled-reason">Solo se guardan picks aprobados.</span>}
        </div>
      </article>
    );
  };

  const selectedParlay = slip.filter((selection) => parlayIds.includes(selection.id));
  const seasonOptions = Array.from({ length: 5 }, (_, index) => 2024 + index);
  const activeDetail = selectedMatchId !== null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><p className="brand-name">Tablero de partidos</p><p className="brand-caption">Evidencia primero · decisiones transparentes</p></div>
        </div>
        <div className="topbar-meta">Hora mostrada en<br /><strong>{timeZone}</strong></div>
      </header>

      <main className="page-frame">
        <nav className="main-nav" aria-label="Navegación principal">
          {([ ["matches", "Partidos"], ["slip", `Slip${slip.length ? ` (${slip.length})` : ""}`], ["settings", "Ajustes"] ] as Array<[View, string]>).map(([target, label]) => (
            <button className="nav-button" key={target} type="button" aria-current={view === target ? "page" : undefined} onClick={() => { setView(target); if (target !== "matches") setSelectedMatchId(null); }}>{label}</button>
          ))}
        </nav>

        {view === "matches" && !activeDetail && (
          <section aria-labelledby="matches-title">
            <div className="page-heading">
              <div><p className="eyebrow">Calendario de fixtures</p><h1 id="matches-title">Encuentra un partido</h1><p className="subheading">Consulta encuentros futuros de la temporada y abre el análisis con los datos históricos disponibles.</p></div>
              <span className="season-badge">Temporada inicial · 2026/2027</span>
            </div>
            <form className="toolbar" onSubmit={submitSearch}>
              <div className="filter-grid">
                <div className="field search-field"><label htmlFor="team-search">Buscar equipo o partido</label><input id="team-search" type="search" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} placeholder="Nombre de equipo o competición" /></div>
                <div className="field"><label htmlFor="season-start">Temporada · año inicial</label><select id="season-start" value={season} onChange={(event) => setSeason(Number(event.target.value))}>{seasonOptions.map((year) => <option key={year} value={year}>{year}/{year + 1}</option>)}</select></div>
                <div className="field"><label htmlFor="fixture-date">Desde la fecha</label><div className="date-navigation"><button className="button secondary small" type="button" aria-label="Fecha anterior" title="Fecha anterior" disabled={!searchDate || searchDate <= today} onClick={() => void shiftSearchDate(-1)}>‹</button><input id="fixture-date" type="date" min={today || undefined} value={searchDate} onChange={(event) => setSearchDate(event.target.value)} /><button className="button secondary small" type="button" aria-label="Fecha siguiente" title="Fecha siguiente" disabled={!searchDate} onClick={() => void shiftSearchDate(1)}>›</button></div></div>
              </div>
              <button className="button" type="submit" disabled={matchesLoading || !searchDate}>Buscar</button>
            </form>
            {matchesError && <div className="inline-error" role="alert"><p>{matchesError}</p><button className="button secondary small" type="button" onClick={() => void submitSearch()}>Reintentar</button></div>}
            <div className="section-title"><div><h2>Próximos encuentros</h2><p>Ventana de consulta de 14 días · las horas indican {timeZone}.</p></div><span className="tag">{fixtures.length} encuentros</span></div>
            {matchesLoading ? <div className="loading-state" aria-live="polite" aria-busy="true">Consultando la fuente de partidos…</div> : fixtures.length ? (
              <div className="fixture-list" role="list">
                {fixtures.map((fixture) => (
                  <button className="fixture-row" type="button" role="listitem" key={fixture.id} onClick={() => { setSelectedMatchId(fixture.id); setView("matches"); }}>
                    <span className="fixture-time">{matchTime(fixture.kickoff, timeZone)}</span>
                    <span className="fixture-teams"><span>{fixture.homeTeam.name}</span><span>{fixture.awayTeam.name}</span></span>
                    <span className="fixture-competition">{fixture.competition?.name ?? "Competición no disponible"} · {fixture.status}</span>
                    <span className="fixture-action">Ver análisis</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state"><h3>{coverage === "unknown" ? "Sin resultados en la cobertura consultada" : "No encontramos partidos"}</h3><p>{coverage === "unknown" ? "La fuente no confirmó encuentros para estos filtros; esto no demuestra que no existan partidos fuera de su cobertura." : `No encontramos partidos para «${query || "esta fecha"}». Ajusta la búsqueda o prueba otra fecha.`}</p></div>
            )}
          </section>
        )}

        {view === "matches" && activeDetail && (
          <section aria-labelledby="analysis-title">
            <button className="button secondary small back-button" type="button" onClick={() => setSelectedMatchId(null)}>Volver a Partidos</button>
            {detailLoading && <div className="loading-state" aria-live="polite" aria-busy="true">Cargando datos disponibles del encuentro…</div>}
            {detailError && <div className="inline-error" role="alert"><p>{detailError}</p><button className="button secondary small" type="button" onClick={() => setSelectedMatchId(selectedMatchId)}>Reintentar</button></div>}
            {match && (
              <>
                <div className="page-heading">
                  <div><p className="eyebrow">{match.competition?.name ?? "Competición no disponible"} · {match.status}</p><div className="match-title"><h1 className="match-team" id="analysis-title">{match.homeTeam.name}</h1><span className="versus">CONTRA</span><h1 className="match-team">{match.awayTeam.name}</h1></div><p className="match-meta">{matchTime(match.kickoff, timeZone)} · Temporada {match.season}/{match.season + 1}{match.lastUpdated ? ` · Actualizado ${matchTime(match.lastUpdated, timeZone)}` : ""}</p></div>
                  <span className="season-badge">{match.status}</span>
                </div>
                <div className="analysis-toolbar">
                  <div><span className="field-label">Ventana comparativa</span><div className="segmented" role="group" aria-label="Ventana comparativa">
                    <button type="button" aria-pressed={comparisonWindow === "season"} onClick={() => setWindow("season")}>Temporada</button>
                    <button type="button" aria-pressed={comparisonWindow === "recent"} onClick={() => setWindow("recent")}>Recientes</button>
                  </div></div>
                  <div className="field"><label htmlFor="comparison-team">Equipo para criterios individuales</label><select id="comparison-team" value={comparisonSide} onChange={(event) => { const side = event.target.value as TeamSide; setComparisonSide(side); setMarketSides(Object.fromEntries(MARKET_DEFINITIONS.map(({ id }) => [id, side])) as Record<MarketId, TeamSide>); }}><option value="home">{match.homeTeam.name}</option><option value="away">{match.awayTeam.name}</option></select></div>
                </div>
                <div className="compare-grid">
                  <ComparisonColumn comparison={match.teamComparisons.home} other={match.teamComparisons.away} window={comparisonWindow} side="home" timeZone={timeZone} />
                  <ComparisonColumn comparison={match.teamComparisons.away} other={match.teamComparisons.home} window={comparisonWindow} side="away" timeZone={timeZone} />
                </div>
                <div className="section-title markets-heading"><div><p className="eyebrow">Evaluación determinista</p><h2>Mercados disponibles</h2><p>Los datos ausentes y las reglas pendientes no reciben veredictos.</p></div><button className="button secondary" type="button" disabled={explanationLoading} onClick={() => void requestMatchExplanation()}>{explanationLoading ? "Preparando explicación…" : "Explicar análisis"}</button></div>
                <div className="verdict-legend" aria-label="Criterios deterministas de los veredictos">
                  <div><strong>SUBIR LÍNEA</strong><span>Margen ≥ 1,30 × colchón ajustado</span></div>
                  <div><strong>APROBADO LÍNEA BASE</strong><span>Margen ≥ colchón ajustado</span></div>
                  <div><strong>REDUCIR RIESGO</strong><span>Margen positivo, menor al colchón</span></div>
                  <div><strong>DESCARTADO POR VARIANZA</strong><span>La evidencia no alcanza la regla</span></div>
                </div>
                <div className="markets-grid">{MARKET_DEFINITIONS.map(({ id }) => renderMarket(id))}</div>
                {explanationError && <div className="inline-error" role="alert" style={{ marginTop: 14 }}><p>{explanationError}</p><button className="button secondary small" type="button" onClick={() => void requestMatchExplanation()}>Reintentar</button></div>}
                {explanation && <div className="explanation" aria-live="polite"><strong>Explicación generada con Gemini</strong>{explanation.statements.length ? <ul>{explanation.statements.map((statement) => <li key={statement.evidenceId}>{statement.text}</li>)}</ul> : <p>No se seleccionaron hechos disponibles para explicar.</p>}<p><strong>Limitaciones</strong></p><ul>{explanation.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>}
              </>
            )}
          </section>
        )}

        {view === "settings" && (
          <section aria-labelledby="settings-title">
            <div className="page-heading"><div><p className="eyebrow">Preferencias locales</p><h1 id="settings-title">Ajustes de análisis</h1><p className="subheading">Los valores se guardan en este navegador. Ningún mercado se aprueba sin regla y colchón configurados.</p></div></div>
            {storageMessage && <div className="notice" role="status">{storageMessage}</div>}
            <div className="section-title"><div><h2>Mercados y colchón base</h2><p>Valores iniciales tomados de los algoritmos aportados; puedes ajustarlos localmente.</p></div></div>
            <div className="settings-list">
              {MARKET_DEFINITIONS.map((market) => {
                const config = preferences.markets[market.id];
                return (
                  <div className="setting-row" key={market.id}>
                    <div><h3>{market.name}</h3><p>{`${METRIC_LABELS[market.metric]} ≥ ${market.line.toLocaleString("es-ES", { maximumFractionDigits: 2 })} antes del colchón de riesgo.`}</p></div>
                    <div className="field"><label htmlFor={`cushion-${market.id}`}>Colchón base requerido</label><input id={`cushion-${market.id}`} type="number" min="0" step="any" value={config.baseCushion ?? ""} placeholder="Requerido" onChange={(event) => { const raw = event.target.value; const value = raw === "" ? null : Number(raw); if (value !== null && (!Number.isFinite(value) || value < 0)) return; persistPreferences({ ...preferences, markets: { ...preferences.markets, [market.id]: { ...config, baseCushion: value } } }); }} /><span className="metric-note">Se aplica como colchón base × (1 + factores activados).</span></div>
                    <label className="risk-setting"><input type="checkbox" checked={config.enabled} onChange={(event) => persistPreferences({ ...preferences, markets: { ...preferences.markets, [market.id]: { ...config, enabled: event.target.checked } } })} /><span><strong>Incluir en análisis</strong><p>Desactiva el mercado sin borrar su configuración.</p></span></label>
                  </div>
                );
              })}
            </div>
            <div className="section-title"><div><h2>Factores de riesgo</h2><p>Al activar un factor, su evidencia debe estar disponible; si falta, bloquea la evaluación. Desactivarlo queda registrado localmente.</p></div></div>
            {(Object.entries(RISK_MODIFIERS) as Array<[RiskFactorId, (typeof RISK_MODIFIERS)[RiskFactorId]]>).map(([id, risk]) => (
              <label className="risk-setting" key={id}>
                <input type="checkbox" checked={preferences.riskSettings[id] !== false} onChange={(event) => persistPreferences({ ...preferences, riskSettings: { ...preferences.riskSettings, [id]: event.target.checked } })} />
                <span><strong>{risk.label} · +{Math.round(risk.modifier * 100)}%</strong><p>Mercados: {risk.markets.map((marketId) => MARKET_DEFINITIONS.find((market) => market.id === marketId)?.name).join(", ")}. La fuente actual no proporciona todas las señales requeridas.</p></span>
              </label>
            ))}
            <p className="footer-note">Si falta xG, proyección de córners o una señal contextual requerida, el mercado permanece no evaluable. Los goles reales no sustituyen esas métricas.</p>
          </section>
        )}

        {view === "slip" && (
          <section aria-labelledby="slip-title">
            <div className="page-heading"><div><p className="eyebrow">Almacenamiento en este navegador</p><h1 id="slip-title">Slip</h1><p className="subheading">Solo se guardan selecciones aprobadas por una regla explícita. No hay cuotas ni retornos calculados.</p></div>{slip.length > 0 && <button className="button danger" type="button" onClick={emptySlip}>Vaciar Slip</button>}</div>
            {storageMessage && <div className="notice" role="status">{storageMessage}</div>}
            {slip.length ? <ul className="slip-list">{slip.map((selection) => (
              <li className="slip-item" key={selection.id}>
                <div><strong>{selection.teamName} · {selection.marketName}</strong><p>{selection.opponentName} · {selection.competitionName} · {matchTime(selection.kickoff, timeZone)}</p><p>{selection.verdict} · regla {selection.ruleVersion}</p></div>
                <button className="button secondary small" type="button" onClick={() => removeSelection(selection.id)}>Quitar</button>
              </li>
            ))}</ul> : <div className="empty-state"><h3>El Slip está vacío</h3><p>Los mercados actuales no cuentan con datos/reglas suficientes para aprobar selecciones. La vista completa de análisis sigue disponible en Partidos.</p><button className="button secondary small" type="button" onClick={() => setView("matches")}>Ir a Partidos</button></div>}

            <section className="parlay-box" aria-labelledby="parlay-title">
              <div className="section-title"><div><p className="eyebrow">Constructor</p><h2 id="parlay-title">Combinada</h2><p>Máximo cuatro equipos distintos. Selecciones incompatibles quedan bloqueadas.</p></div><span className="tag">{selectedParlay.length}/4 equipos</span></div>
              {slip.length ? <div className="candidate-list">{slip.map((candidate) => {
                const selected = parlayIds.includes(candidate.id);
                const selectedOther = slip.filter((item) => parlayIds.includes(item.id) && item.id !== candidate.id);
                const reason = selected ? null : getParlayBlockReason(candidate, selectedOther);
                return <label className="candidate" key={candidate.id}><input type="checkbox" checked={selected} disabled={!selected && Boolean(reason)} onChange={(event) => setParlayIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><span><strong>{candidate.teamName} · {candidate.marketName}</strong><p>{candidate.opponentName} · {candidate.verdict}{reason ? ` · Bloqueado: ${reason}` : ""}</p></span></label>;
              })}</div> : <p className="empty-inline">Añade picks aprobados desde un análisis para construir una combinada.</p>}
              <div className="button-row"><button className="button" type="button" disabled={parlayLoading || selectedParlay.length === 0 || selectedParlay.length > 4} onClick={() => void requestParlayExplanation()}>{parlayLoading ? "Solicitando explicación…" : "Explicar combinada"}</button><span className="metric-note">El servidor vuelve a validar cada selección; Gemini no aprueba picks.</span></div>
              {parlayError && <div className="inline-error" role="alert" style={{ marginTop: 12 }}><p>{parlayError}</p><button className="button secondary small" type="button" onClick={() => void requestParlayExplanation()}>Reintentar</button></div>}
              {parlayExplanation && <div className="explanation" aria-live="polite"><strong>Explicación generada con Gemini</strong><ul>{parlayExplanation.statements.map((statement) => <li key={statement.evidenceId}>{statement.text}</li>)}</ul><p><strong>Limitaciones</strong></p><ul>{parlayExplanation.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>}
            </section>
          </section>
        )}

        <p className="footer-note">Las métricas ausentes no se sustituyen por cero. football-data.org no proporciona xG, córners, métricas de portero, posesión, duelos, despejes ni cuotas para esta aplicación.</p>
      </main>
    </div>
  );
}