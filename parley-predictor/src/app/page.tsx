"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ANALYSIS_LIMITS,
  FORECAST_DECISIONS,
  FORECAST_TYPES,
  MARKET_TEAMS,
  MARKET_TYPES,
  RULE_TRIGGERS,
  inferForecastType,
  inferMarketTeam,
  inferMarketType,
  type AnalysisResponse,
  type ForecastDecisionKind,
  type ForecastType,
  type Market,
  type MarketTeam,
  type MarketType,
  type Rule,
  type RuleTrigger,
  type Verdict,
} from "@/lib/analysis-contract";
import { DEFAULT_MARKETS, DEFAULT_RULES } from "@/lib/default-config";

type ConfigMarket = Market & { active: boolean };
type ConfigRule = Rule & { active: boolean };
type LocalConfig = { markets: ConfigMarket[]; rules: ConfigRule[] };
type AnalysisStage = "normalization" | "analysis";
type ServiceState = "checking" | "ready" | "missing" | "unavailable";
type Editor =
  | { kind: "market"; value: ConfigMarket; originalId?: string }
  | { kind: "rule"; value: ConfigRule; originalId?: string };

const STORAGE_KEY = "parley-predictor.config.v1";
const INITIAL_CONFIG: LocalConfig = {
  markets: DEFAULT_MARKETS.map((market) => ({ ...market, active: true })),
  rules: DEFAULT_RULES.map((rule) => ({ ...rule, active: true })),
};
const TRIGGER_LABELS: Record<RuleTrigger, string> = {
  goalkeeping: "Portería",
  penalties: "Penales",
  aerialPressure: "Asedio aéreo",
  fatigueTransition: "Fatiga-transición",
  other: "Otro",
};
const MARKET_TYPE_LABELS: Record<MarketType, string> = {
  corners: "Córners",
  totalGoals: "Goles totales",
  teamGoals: "Gol individual",
  handicap: "Hándicap",
  generic: "Otro mercado",
};
const FORECAST_TYPE_LABELS: Record<ForecastType, string> = {
  over: "Over",
  under: "Under",
  moneyline: "Ganador / 1X2",
  handicap: "Hándicap",
};
const MARKET_TEAM_LABELS: Record<MarketTeam, string> = {
  home: "Local",
  away: "Visitante",
  both: "Ambos equipos",
};
const FORECAST_DECISION_LABELS: Record<ForecastDecisionKind, string> = {
  maintained: "Línea base",
  upgraded: "Línea escalada",
  inverted_suggestion: "Tendencia contraria",
};
const STAGE_LABELS: Record<AnalysisStage, string> = {
  normalization: "Normalizando y filtrando métricas",
  analysis: "Evaluando mercados y reglas",
};

function copyConfig(config: LocalConfig): LocalConfig {
  return {
    markets: config.markets.map((market) => ({ ...market })),
    rules: config.rules.map((rule) => ({ ...rule })),
  };
}

function migrateConfig(config: LocalConfig): LocalConfig {
  return {
    markets: config.markets.map((market) => {
      const marketType = market.marketType ?? inferMarketType(market.id ?? "", market.name ?? "", market.line ?? "");
      return {
        ...market,
        marketType,
        forecastType: market.forecastType ?? inferForecastType(
          marketType,
          market.line ?? "",
          market.name ?? "",
        ),
        team: market.team ?? inferMarketTeam(marketType, market.id ?? "", market.name ?? "", market.line ?? ""),
      };
    }),
    rules: config.rules.map((rule) => ({ ...rule })),
  };
}

function validateStoredConfig(value: unknown): value is LocalConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalConfig>;
  if (!Array.isArray(candidate.markets) || !Array.isArray(candidate.rules)) return false;
  if (candidate.markets.length > ANALYSIS_LIMITS.markets || candidate.rules.length > ANALYSIS_LIMITS.rules) return false;
  const validMarkets = candidate.markets.every((item) => {
    if (!item || typeof item !== "object") return false;
    const market = item as ConfigMarket;
    return typeof market.id === "string" && Boolean(market.id.trim()) && market.id.length <= 100 &&
      typeof market.name === "string" && Boolean(market.name.trim()) && market.name.length <= 120 &&
      typeof market.description === "string" && market.description.length <= 2_000 &&
      typeof market.line === "string" && Boolean(market.line.trim()) && market.line.length <= 100 &&
      typeof market.baseCushion === "number" && Number.isFinite(market.baseCushion) && market.baseCushion >= 0 &&
      (market.marketType === undefined || MARKET_TYPES.includes(market.marketType)) &&
      (market.forecastType === undefined || FORECAST_TYPES.includes(market.forecastType)) &&
      (market.team === undefined || MARKET_TEAMS.includes(market.team)) &&
      typeof market.active === "boolean";
  });
  const validRules = candidate.rules.every((item) => {
    if (!item || typeof item !== "object") return false;
    const rule = item as ConfigRule;
    return typeof rule.id === "string" && Boolean(rule.id.trim()) && rule.id.length <= 100 &&
      typeof rule.name === "string" && Boolean(rule.name.trim()) && rule.name.length <= 120 &&
      typeof rule.instructions === "string" && rule.instructions.length <= 2_000 &&
      typeof rule.riskFactor === "number" && Number.isFinite(rule.riskFactor) && rule.riskFactor >= 0 && rule.riskFactor <= 1 &&
      RULE_TRIGGERS.includes(rule.trigger) && typeof rule.active === "boolean";
  });
  return validMarkets && validRules &&
    new Set(candidate.markets.map((market) => market.id)).size === candidate.markets.length &&
    new Set(candidate.rules.map((rule) => rule.id)).size === candidate.rules.length;
}

function errorMessage(code: string, stage?: string): string {
  const messages: Record<string, string> = {
    MISSING_API_KEY: "El servicio de análisis aún no tiene configurada su clave en el servidor.",
    INVALID_REQUEST: "La solicitud no cumple el contrato del análisis. Revisa los datos y la configuración.",
    INVALID_CONTENT_TYPE: "No se pudo enviar la solicitud en el formato esperado.",
    PAYLOAD_TOO_LARGE: "La solicitud supera el tamaño permitido. Reduce los datos del partido.",
    INTERNAL_ERROR: "Ocurrió un error interno y el análisis no se completó.",
  };
  if (code === "UPSTREAM_ERROR") {
    return stage === "normalization"
      ? "El proveedor no pudo completar la normalización."
      : "El proveedor no pudo completar la evaluación de mercados y reglas.";
  }
  if (code === "UPSTREAM_UNAVAILABLE") {
    return "Gemini está temporalmente ocupado o alcanzó un límite de solicitudes. Espera unos minutos y reintenta.";
  }
  if (code === "UPSTREAM_TIMEOUT") {
    return stage === "normalization"
      ? "Gemini tardó más de 150 segundos en normalizar los datos. Conserva el informe, revisa GEMINI_MODEL en el servidor o vuelve a intentarlo."
      : "Gemini tardó más de 150 segundos en evaluar los mercados y reglas. Conserva el informe, revisa GEMINI_MODEL en el servidor o vuelve a intentarlo.";
  }
  if (code === "INVALID_PROVIDER_RESPONSE") {
    return stage === "normalization"
      ? "El proveedor devolvió datos de normalización no válidos."
      : "El proveedor devolvió dictámenes no válidos.";
  }
  return messages[code] ?? (stage === "normalization"
    ? "No se pudo completar la etapa de normalización."
    : "No se pudo completar la etapa de análisis.");
}

function stageLabel(stage: string): string {
  if (stage === "normalization") return "Normalización";
  if (stage === "validation") return "Validación";
  if (stage === "configuration") return "Configuración del servicio";
  return "Análisis";
}

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<AnalysisResponse>;
  return Boolean(response.normalizedData && typeof response.normalizedData === "object" && !Array.isArray(response.normalizedData) &&
    Array.isArray(response.verdicts) && response.verdicts.every((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const item = candidate as Verdict;
      return typeof item.marketId === "string" && typeof item.selection === "string" &&
        (item.projection === null || (typeof item.projection === "number" && Number.isFinite(item.projection))) &&
        FORECAST_DECISIONS.includes(item.forecastDecision) &&
        MARKET_TEAMS.includes(item.team) &&
        typeof item.probability === "number" && Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1 &&
        typeof item.rationale === "string" && Array.isArray(item.activeRuleIds) &&
        typeof item.riskSum === "number" && Number.isFinite(item.riskSum) &&
        typeof item.baseCushion === "number" && Number.isFinite(item.baseCushion) &&
        typeof item.adjustedCushion === "number" && Number.isFinite(item.adjustedCushion) &&
        Array.isArray(item.activeRules) && item.activeRules.every((rule) =>
          typeof rule.id === "string" && typeof rule.name === "string" &&
          RULE_TRIGGERS.includes(rule.trigger) && typeof rule.riskFactor === "number" && Number.isFinite(rule.riskFactor));
    }) && Array.isArray(response.discardedMarkets) && response.discardedMarkets.every((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const item = candidate as AnalysisResponse["discardedMarkets"][number];
      return typeof item.marketId === "string" &&
        (item.projection === null || (typeof item.projection === "number" && Number.isFinite(item.projection))) &&
        typeof item.reason === "string";
    }));
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export default function Home() {
  const [config, setConfig] = useState<LocalConfig>(() => copyConfig(INITIAL_CONFIG));
  const [rawMatchData, setRawMatchData] = useState("");
  const [service, setService] = useState<ServiceState>("checking");
  const [serviceMessage, setServiceMessage] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [storageNeedsRecovery, setStorageNeedsRecovery] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<LocalConfig | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorErrors, setEditorErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [inputError, setInputError] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [response, setResponse] = useState<AnalysisResponse | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const storageTask = window.setTimeout(() => {
      let stored: string | null | undefined;
      try {
        stored = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        stored = undefined;
        setStorageMessage("No se pudo acceder al almacenamiento local. La configuración inicial sigue disponible solo en esta sesión.");
      }
      if (stored !== undefined && stored !== null) {
        try {
          const parsed: unknown = JSON.parse(stored);
          if (validateStoredConfig(parsed)) {
            const migrated = migrateConfig(parsed);
            const hasLegacyMarkets = parsed.markets.some((market) =>
              market.marketType === undefined || market.forecastType === undefined,
            );
            setConfig(migrated);
            if (hasLegacyMarkets) {
              try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
                setStorageMessage("Configuración local antigua migrada y guardada en este navegador.");
              } catch {
                setStorageMessage("Configuración antigua adaptada para esta sesión; no se pudo guardar la migración local.");
              }
            } else {
              setStorageMessage("Configuración local cargada en este navegador.");
            }
          } else {
            setStorageNeedsRecovery(true);
            setStorageMessage("La configuración guardada no es válida. Se conserva sin modificar; puedes restaurar los valores iniciales explícitamente.");
          }
        } catch {
          setStorageNeedsRecovery(true);
          setStorageMessage("La configuración guardada no es JSON válido. Se conserva sin modificar; puedes restaurar los valores iniciales explícitamente.");
        }
      } else if (stored === null) {
        setStorageMessage("Configuración inicial cargada; aún no se ha guardado en este navegador.");
      }
    }, 0);

    void fetch("/api/status", { cache: "no-store" })
      .then(async (result) => {
        if (!result.ok) throw new Error("status");
        const data: unknown = await result.json();
        if (!data || typeof data !== "object" || typeof (data as { configured?: unknown }).configured !== "boolean") throw new Error("status");
        const configured = (data as { configured: boolean }).configured;
        setService(configured ? "ready" : "missing");
        setServiceMessage(configured
          ? "El servidor confirma que el servicio está configurado."
          : "El servidor aún no tiene configurada la clave del servicio.");
      })
      .catch(() => {
        setService("unavailable");
        setServiceMessage("No se pudo consultar el estado del servicio.");
      });
    return () => window.clearTimeout(storageTask);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (configOpen && !dialog.open) dialog.showModal();
    if (!configOpen && dialog.open) dialog.close();
  }, [configOpen]);

  function persistConfig(next: LocalConfig): void {
    setConfig(copyConfig(next));
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setStorageNeedsRecovery(false);
      setStorageMessage("Configuración guardada en este navegador.");
    } catch {
      setStorageMessage("No se pudieron guardar los cambios en el almacenamiento local. Se mantienen solo durante esta sesión.");
    }
  }

  function openConfiguration(): void {
    setDraft(copyConfig(config));
    setEditor(null);
    setEditorErrors({});
    setFormError("");
    setConfigOpen(true);
  }

  function closeConfiguration(): void {
    setConfigOpen(false);
    setEditor(null);
    setFormError("");
  }

  function beginCreate(kind: "market" | "rule"): void {
    if (!draft) return;
    const count = kind === "market" ? draft.markets.length : draft.rules.length;
    const maximum = kind === "market" ? ANALYSIS_LIMITS.markets : ANALYSIS_LIMITS.rules;
    if (count >= maximum) {
      setFormError(`No puedes superar ${maximum} ${kind === "market" ? "mercados" : "reglas"}.`);
      return;
    }
    setFormError("");
    setEditorErrors({});
    setEditor(kind === "market"
      ? { kind, value: { id: "", name: "", description: "", line: "", baseCushion: 0, marketType: "generic", forecastType: "over", team: "both", active: true } }
      : { kind, value: { id: "", name: "", instructions: "", riskFactor: 0, trigger: "other", active: true } });
  }

  function beginEdit(kind: "market" | "rule", id: string): void {
    if (!draft) return;
    setEditorErrors({});
    setFormError("");
    setEditor(kind === "market"
      ? { kind, value: { ...draft.markets.find((item) => item.id === id)! }, originalId: id }
      : { kind, value: { ...draft.rules.find((item) => item.id === id)! }, originalId: id });
  }

  function updateEditorTextField(field: "id" | "name", value: string): void {
    if (!editor) return;
    if (editor.kind === "market") {
      setEditor({ ...editor, value: { ...editor.value, [field]: value } });
    } else {
      setEditor({ ...editor, value: { ...editor.value, [field]: value } });
    }
  }

  function saveEditor(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!editor || !draft) return;
    const { kind, value, originalId } = editor;
    const errors: Record<string, string> = {};
    if (!value.id.trim()) errors.id = "El identificador es obligatorio.";
    else if (value.id.length > ANALYSIS_LIMITS.idCharacters) errors.id = "Máximo 100 caracteres.";
    if (!value.name.trim()) errors.name = "El nombre es obligatorio.";
    else if (value.name.length > ANALYSIS_LIMITS.nameCharacters) errors.name = "Máximo 120 caracteres.";
    if (kind === "market") {
      if (value.description.length > ANALYSIS_LIMITS.descriptionCharacters) errors.description = "Máximo 2.000 caracteres.";
      if (!value.line.trim()) errors.line = "La línea es obligatoria.";
      else if (value.line.length > ANALYSIS_LIMITS.lineCharacters) errors.line = "Máximo 100 caracteres.";
      if (!Number.isFinite(value.baseCushion) || value.baseCushion < 0) errors.baseCushion = "Usa un número finito mayor o igual que 0.";
      if (draft.markets.some((item) => item.id === value.id.trim() && item.id !== originalId)) errors.id = "Este identificador ya existe.";
    } else {
      if (value.instructions.length > ANALYSIS_LIMITS.instructionsCharacters) errors.instructions = "Máximo 2.000 caracteres.";
      if (!Number.isFinite(value.riskFactor) || value.riskFactor < 0 || value.riskFactor > 1) errors.riskFactor = "Usa un número entre 0 y 1.";
      if (draft.rules.some((item) => item.id === value.id.trim() && item.id !== originalId)) errors.id = "Este identificador ya existe.";
    }
    setEditorErrors(errors);
    if (Object.keys(errors).length) return;
    if (kind === "market") {
      const market: ConfigMarket = { ...value, id: value.id.trim(), name: value.name.trim(), line: value.line.trim() };
      setDraft({ ...draft, markets: originalId
        ? draft.markets.map((item) => item.id === originalId ? market : item)
        : [...draft.markets, market] });
    } else {
      const rule: ConfigRule = { ...value, id: value.id.trim(), name: value.name.trim() };
      setDraft({ ...draft, rules: originalId
        ? draft.rules.map((item) => item.id === originalId ? rule : item)
        : [...draft.rules, rule] });
    }
    setEditor(null);
    setEditorErrors({});
    setFormError("");
  }

  function saveConfiguration(): void {
    if (!draft || editor) return;
    persistConfig(draft);
    setResponse(null);
    setDraft(null);
    setConfigOpen(false);
    setEditor(null);
  }

  async function analyzeMatch(): Promise<void> {
    setInputError("");
    setSelectionError("");
    setAnalysisError("");
    setResponse(null);
    if (!rawMatchData.trim()) {
      setInputError("Introduce los datos del partido.");
      document.getElementById("match-data")?.focus();
      return;
    }
    if (rawMatchData.length > ANALYSIS_LIMITS.rawMatchDataCharacters) {
      setInputError("Los datos superan el máximo de 50.000 caracteres.");
      document.getElementById("match-data")?.focus();
      return;
    }
    const markets = config.markets.filter((market) => market.active);
    const rules = config.rules.filter((rule) => rule.active);
    if (!markets.length || !rules.length) {
      setSelectionError("Activa al menos un mercado y una regla para analizar.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisStage(null);
    setAnnouncement("Iniciando análisis.");
    try {
      const result = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
        body: JSON.stringify({
          rawMatchData,
          markets: markets.map((market) => ({
            id: market.id,
            name: market.name,
            description: market.description,
            line: market.line,
            baseCushion: market.baseCushion,
            marketType: market.marketType,
            forecastType: market.forecastType,
            team: market.team,
          })),
          rules: rules.map((rule) => ({
            id: rule.id,
            name: rule.name,
            instructions: rule.instructions,
            riskFactor: rule.riskFactor,
            trigger: rule.trigger,
          })),
        }),
      });
      if (!result.ok) {
        let code = "INTERNAL_ERROR";
        let stage = "analysis";
        try {
          const body: unknown = await result.json();
          if (body && typeof body === "object" && "error" in body) {
            const failure = (body as { error?: { code?: unknown; stage?: unknown } }).error;
            if (typeof failure?.code === "string") code = failure.code;
            if (typeof failure?.stage === "string") stage = failure.stage;
          }
        } catch {
          code = "INTERNAL_ERROR";
        }
        setAnalysisError(`${stageLabel(stage)}: ${errorMessage(code, stage)}`);
        setAnnouncement("El análisis no se completó.");
        return;
      }
      if (!result.body) throw new Error("EMPTY_STREAM");
      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const receivedResult: { current: AnalysisResponse | null } = { current: null };
      let receivedError = "";
      const handleBlock = (block: string): void => {
        const message = parseSseBlock(block);
        if (!message) return;
        const data: unknown = JSON.parse(message.data);
        if (message.event === "stage" && data && typeof data === "object") {
          const stage = (data as { stage?: unknown }).stage;
          if (stage === "normalization" || stage === "analysis") {
            setAnalysisStage(stage);
            setAnnouncement(STAGE_LABELS[stage]);
          }
        } else if (message.event === "result") {
          if (!isAnalysisResponse(data)) throw new Error("INVALID_RESULT");
          receivedResult.current = data;
        } else if (message.event === "error" && data && typeof data === "object") {
          const failure = (data as { error?: { code?: unknown; stage?: unknown } }).error;
          const code = typeof failure?.code === "string" ? failure.code : "INTERNAL_ERROR";
          const stage = typeof failure?.stage === "string" ? failure.stage : "analysis";
          receivedError = `${stageLabel(stage)}: ${errorMessage(code, stage)}`;
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          handleBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (buffer.trim()) handleBlock(buffer);
      const finalResponse = receivedResult.current;
      if (receivedError) {
        setAnalysisError(receivedError);
        setAnnouncement("El análisis no se completó.");
      } else if (!finalResponse) {
        setAnalysisError("El flujo terminó sin una respuesta de análisis válida.");
        setAnnouncement("El análisis no se completó.");
      } else {
        setResponse(finalResponse);
        const evaluatedMarkets = finalResponse.verdicts.length + finalResponse.discardedMarkets.length;
        setAnnouncement(`Análisis completado. ${evaluatedMarkets} mercados evaluados, ${finalResponse.verdicts.length} aprobados y ${finalResponse.discardedMarkets.length} descartados o sin proyección.`);
      }
    } catch {
      setAnalysisError("No se pudo completar el análisis por un error de conexión o una respuesta no válida.");
      setAnnouncement("El análisis no se completó.");
    } finally {
      setIsAnalyzing(false);
      setAnalysisStage(null);
    }
  }

  const activeMarketCount = config.markets.filter((market) => market.active).length;
  const activeRuleCount = config.rules.filter((rule) => rule.active).length;
  const sortedVerdicts = response
    ? [...response.verdicts].sort((first, second) => second.probability - first.probability)
    : [];

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#inicio" aria-label="Parley, inicio"><span className="wordmark-mark" aria-hidden="true">P</span><span>PARLEY <span className="wordmark-light">/ ANALÍTICA</span></span></a>
        <div className={`service-indicator service-${service}`} role="status" aria-live="polite"><span className="service-dot" aria-hidden="true" />{service === "checking" && "Consultando servicio"}{service === "ready" && "Servicio listo"}{service === "missing" && "Configuración del servicio pendiente"}{service === "unavailable" && "Estado del servicio no disponible"}</div>
      </header>

      <div className="content-wrap" id="inicio">
        <section className="page-heading" aria-labelledby="page-title"><div><p className="eyebrow">CENTRO DE ESTUDIO · 01</p><h1 id="page-title">Análisis del partido</h1><p className="heading-copy">Una lectura estructurada de los datos disponibles, sin certezas prestadas.</p></div><div className="edition-mark"><span className="edition-line" /><span>LABORATORIO<br />DE ESCENARIOS</span></div></section>

        <div className="workspace-grid">
          <section className="analysis-column" aria-label="Entrada y resultados del análisis">
            <section className="panel input-panel" aria-labelledby="input-title">
              <div className="section-heading"><div className="section-title-wrap"><span className="section-index">01</span><div><p className="eyebrow">ENTRADA</p><h2 id="input-title">Datos del partido</h2></div></div><span className="field-limit">Hasta 50.000 caracteres</span></div>
              <label className="sr-only" htmlFor="match-data">Datos del partido</label>
              <textarea id="match-data" value={rawMatchData} onChange={(event) => { setRawMatchData(event.target.value); setResponse(null); if (inputError) setInputError(""); }} aria-invalid={Boolean(inputError)} aria-describedby={inputError ? "match-error" : "match-hint"} placeholder="Pega el informe completo, incluidos encabezados, viñetas, alineaciones y estadísticas." maxLength={ANALYSIS_LIMITS.rawMatchDataCharacters} rows={7} />
              <div className="field-footer"><p id={inputError ? "match-error" : "match-hint"} className={inputError ? "field-error" : "field-hint"}>{inputError || "El texto se conserva solo mientras esta página esté abierta."}</p><span className="character-count" aria-live="polite">{rawMatchData.length.toLocaleString("es-ES")} / 50.000</span></div>
              <div className="selection-strip"><div><p className="eyebrow">SELECCIÓN ACTIVA</p><p className="selection-count"><strong>{activeMarketCount}</strong> mercados <span>/</span> <strong>{activeRuleCount}</strong> reglas</p></div><button className="button button-secondary" type="button" onClick={openConfiguration}>Mercados y reglas</button></div>
              {selectionError && <p className="inline-error" role="alert">{selectionError}</p>}
              <div className="submit-row"><button className="button button-primary" type="button" onClick={() => void analyzeMatch()} disabled={isAnalyzing}>{isAnalyzing ? "Analizando…" : "Analizar partido"}</button><p className="transfer-note">Al analizar, los datos se envían al servidor y se procesan mediante Gemini.</p></div>
              <p className="service-detail" aria-live="polite">{serviceMessage}</p>
            </section>

            <section className="results-section" aria-labelledby="results-title">
              <div className="results-heading"><div className="section-title-wrap"><span className="section-index section-index-coral">02</span><div><p className="eyebrow">LECTURA</p><h2 id="results-title">Dictámenes</h2></div></div>{response && <span className="result-count">{response.verdicts.length} aprobados · {response.discardedMarkets.length} descartados</span>}</div>
              <div className="stage-track" aria-label="Etapas del análisis">{(["normalization", "analysis"] as const).map((stage, index) => { const active = analysisStage === stage; const completed = analysisStage === "analysis" && index === 0; return <div className={`stage-item${active ? " is-active" : ""}${completed ? " is-complete" : ""}`} key={stage}><span className="stage-number">0{index + 1}</span><span>{STAGE_LABELS[stage]}</span></div>; })}</div>
              <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
              {isAnalyzing && <div className="progress-message" role="status" aria-live="polite"><span className="progress-rule" /><span>{analysisStage ? STAGE_LABELS[analysisStage] : "Preparando el análisis"}</span></div>}
              {analysisError && <div className="error-panel" role="alert"><div><p className="eyebrow">ANÁLISIS NO COMPLETADO</p><p>{analysisError}</p></div><button className="button button-secondary" type="button" onClick={() => void analyzeMatch()} disabled={isAnalyzing}>Reintentar</button></div>}
              {!isAnalyzing && !analysisError && !response && <div className="empty-state"><span className="empty-index" aria-hidden="true">—</span><p>Aún no hay resultados. Introduce los datos del partido y ejecuta el análisis.</p></div>}
              {response && response.verdicts.length === 0 && <div className="empty-state empty-state-result" role="status"><span className="empty-index" aria-hidden="true">0</span><div><p>Ningún mercado superó los criterios para aprobar una jugada.</p><span>Consulta los motivos de descarte y las proyecciones recibidas.</span></div><button className="button button-secondary" type="button" onClick={() => void analyzeMatch()} disabled={isAnalyzing}>Volver a analizar</button></div>}
              {sortedVerdicts.length > 0 && <div className="verdict-list" aria-label="Dictámenes ordenados por probabilidad descendente">{sortedVerdicts.map((verdict, index) => { const market = config.markets.find((item) => item.id === verdict.marketId); return <article className="verdict-row" key={`${verdict.marketId}-${verdict.selection}-${index}`}>
                <div className="verdict-main"><div className="verdict-title-line"><span className="verdict-rank">{String(index + 1).padStart(2, "0")}</span><div><p className="verdict-market">{market?.name ?? verdict.marketId}</p><h3>{verdict.selection}</h3><span className="trigger-label">{FORECAST_DECISION_LABELS[verdict.forecastDecision]} · {MARKET_TEAM_LABELS[verdict.team]}</span></div></div><p className="verdict-rationale">{verdict.rationale}</p></div>
                <div className="verdict-metrics"><div className="probability-metric"><span>Probabilidad</span><strong>{new Intl.NumberFormat("es-ES", { style: "percent", maximumFractionDigits: 1 }).format(verdict.probability)}</strong></div><div className="cushion-metrics"><div><span>Proyección</span><strong>{verdict.projection === null ? "No aplica" : String(verdict.projection)}</strong></div><div><span>Colchón base</span><strong>{String(verdict.baseCushion)}</strong></div><div><span>Suma de riesgos</span><strong>{String(verdict.riskSum)}</strong></div><div><span>Colchón ajustado</span><strong>{String(verdict.adjustedCushion)}</strong></div></div></div>
                <div className="active-rules"><span className="active-rules-label">Reglas y triggers activos</span>{verdict.activeRules.length ? <ul>{verdict.activeRules.map((rule) => <li key={rule.id}><span>{rule.name}</span><span className="trigger-label">{TRIGGER_LABELS[rule.trigger] ?? rule.trigger}</span></li>)}</ul> : <p>Sin reglas activas en este dictamen.</p>}</div>
              </article>; })}</div>}
              {response && response.discardedMarkets.length > 0 && <section className="discarded-list" aria-labelledby="discarded-title"><h3 id="discarded-title">Mercados descartados o sin evaluación</h3><ul>{response.discardedMarkets.map((item) => { const market = config.markets.find((candidate) => candidate.id === item.marketId); return <li key={item.marketId}><div><strong>{market?.name ?? item.marketId}</strong>{item.projection !== null && <span>Proyección: {item.projection}</span>}</div><p>{item.reason}</p></li>; })}</ul></section>}
              <p className="uncertainty-notice">Las probabilidades son estimaciones sujetas a incertidumbre; no garantizan resultados. El análisis no es asesoramiento financiero ni una recomendación de apuesta. Juega de forma responsable.</p>
              {response && <details className="normalized-details"><summary>Consultar datos normalizados recibidos</summary><pre>{JSON.stringify(response.normalizedData, null, 2)}</pre></details>}
            </section>
          </section>

          <aside className="context-column" aria-label="Contexto del análisis"><section className="context-note"><p className="eyebrow">CRITERIO</p><p>Una probabilidad describe una estimación del análisis, no la certeza de un resultado.</p><span className="note-rule" /><p className="context-small">Sin datos suficientes, no hay dictamen que mostrar.</p></section><section className="context-meta"><p className="eyebrow">PARÁMETROS</p><div><span>Mercados disponibles</span><strong>{config.markets.length}</strong></div><div><span>Reglas disponibles</span><strong>{config.rules.length}</strong></div><button type="button" className="text-button" onClick={openConfiguration}>Gestionar configuración</button></section><p className="privacy-note">La configuración se guarda solo en este navegador. No introduzcas datos sensibles en el texto del partido.</p></aside>
        </div>
      </div>

      <dialog ref={dialogRef} className="config-dialog" aria-labelledby="config-title" onCancel={(event) => { event.preventDefault(); closeConfiguration(); }} onClick={(event) => { if (event.target === dialogRef.current) closeConfiguration(); }}>
        {configOpen && draft && <div className="config-drawer">
          <header className="drawer-header"><div><p className="eyebrow">CONFIGURACIÓN LOCAL</p><h2 id="config-title">Mercados y reglas</h2><p>Los cambios se aplican a este navegador y a los próximos análisis.</p></div><button className="close-button" type="button" onClick={closeConfiguration} aria-label="Cerrar configuración">Cerrar</button></header>
          {storageNeedsRecovery && <div className="storage-alert" role="alert"><p>{storageMessage}</p><button className="button button-secondary" type="button" onClick={() => persistConfig(copyConfig(INITIAL_CONFIG))}>Restaurar configuración inicial</button></div>}
          {storageMessage && !storageNeedsRecovery && <p className="drawer-storage-note" role="status">{storageMessage}</p>}

          <section className="config-group" aria-labelledby="markets-heading"><div className="config-group-heading"><div><p className="eyebrow">01 · SELECCIONES</p><h3 id="markets-heading">Mercados <span>{draft.markets.length}/{ANALYSIS_LIMITS.markets}</span></h3></div><button className="button button-secondary button-compact" type="button" onClick={() => beginCreate("market")}>Añadir mercado</button></div>
            {draft.markets.length === 0 && <p className="config-empty">No hay mercados configurados.</p>}
            <ul className="config-list">{draft.markets.map((market) => <li key={market.id} className="config-item"><label className="toggle-label"><input type="checkbox" checked={market.active} onChange={(event) => setDraft({ ...draft, markets: draft.markets.map((item) => item.id === market.id ? { ...item, active: event.target.checked } : item) })} /><span className="toggle-copy"><strong>{market.name || "Sin nombre"}</strong><small>{market.line || "Sin línea"} · {MARKET_TEAM_LABELS[market.team]} · colchón base {market.baseCushion}</small></span></label><div className="item-actions"><button type="button" className="text-button" onClick={() => beginEdit("market", market.id)}>Editar</button><button type="button" className="text-button text-danger" onClick={() => setDraft({ ...draft, markets: draft.markets.filter((item) => item.id !== market.id) })}>Eliminar</button></div></li>)}</ul>
          </section>

          <section className="config-group" aria-labelledby="rules-heading"><div className="config-group-heading"><div><p className="eyebrow">02 · CRITERIOS</p><h3 id="rules-heading">Reglas <span>{draft.rules.length}/{ANALYSIS_LIMITS.rules}</span></h3></div><button className="button button-secondary button-compact" type="button" onClick={() => beginCreate("rule")}>Añadir regla</button></div>
            {draft.rules.length === 0 && <p className="config-empty">No hay reglas configuradas.</p>}
            <ul className="config-list">{draft.rules.map((rule) => <li key={rule.id} className="config-item"><label className="toggle-label"><input type="checkbox" checked={rule.active} onChange={(event) => setDraft({ ...draft, rules: draft.rules.map((item) => item.id === rule.id ? { ...item, active: event.target.checked } : item) })} /><span className="toggle-copy"><strong>{rule.name || "Sin nombre"}</strong><small>{TRIGGER_LABELS[rule.trigger]} · factor {rule.riskFactor}</small></span></label><div className="item-actions"><button type="button" className="text-button" onClick={() => beginEdit("rule", rule.id)}>Editar</button><button type="button" className="text-button text-danger" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((item) => item.id !== rule.id) })}>Eliminar</button></div></li>)}</ul>
          </section>
          {(!draft.markets.some((item) => item.active) || !draft.rules.some((item) => item.active)) && <p className="inline-error" role="alert">Para analizar, deja al menos un mercado y una regla activos.</p>}
          {formError && <p className="inline-error" role="alert">{formError}</p>}

          {editor && <form className="editor-form" onSubmit={saveEditor} noValidate>
            <div className="editor-heading"><div><p className="eyebrow">{editor.originalId ? "EDICIÓN" : "NUEVO ELEMENTO"}</p><h3>{editor.kind === "market" ? "Mercado" : "Regla"}</h3></div><button type="button" className="text-button" onClick={() => setEditor(null)}>Cancelar edición</button></div>
            <div className="form-grid">
              <label className="form-field">Identificador<input value={editor.value.id} maxLength={ANALYSIS_LIMITS.idCharacters} aria-invalid={Boolean(editorErrors.id)} aria-describedby={editorErrors.id ? "editor-id-error" : undefined} onChange={(event) => updateEditorTextField("id", event.target.value)} />{editorErrors.id && <span className="field-error" id="editor-id-error">{editorErrors.id}</span>}</label>
              <label className="form-field">Nombre<input value={editor.value.name} maxLength={ANALYSIS_LIMITS.nameCharacters} aria-invalid={Boolean(editorErrors.name)} aria-describedby={editorErrors.name ? "editor-name-error" : undefined} onChange={(event) => updateEditorTextField("name", event.target.value)} />{editorErrors.name && <span className="field-error" id="editor-name-error">{editorErrors.name}</span>}</label>
              {editor.kind === "market" ? <>
                <label className="form-field form-field-wide">Descripción<textarea rows={3} value={editor.value.description} maxLength={ANALYSIS_LIMITS.descriptionCharacters} aria-invalid={Boolean(editorErrors.description)} aria-describedby={editorErrors.description ? "editor-description-error" : undefined} onChange={(event) => setEditor({ kind: "market", value: { ...editor.value, description: event.target.value }, originalId: editor.originalId })} />{editorErrors.description && <span className="field-error" id="editor-description-error">{editorErrors.description}</span>}</label>
                <label className="form-field">Línea<input value={editor.value.line} maxLength={ANALYSIS_LIMITS.lineCharacters} aria-invalid={Boolean(editorErrors.line)} aria-describedby={editorErrors.line ? "editor-line-error" : undefined} onChange={(event) => setEditor({ kind: "market", value: { ...editor.value, line: event.target.value }, originalId: editor.originalId })} />{editorErrors.line && <span className="field-error" id="editor-line-error">{editorErrors.line}</span>}</label>
                <label className="form-field">Tipo de mercado<select value={editor.value.marketType} onChange={(event) => setEditor({ kind: "market", value: { ...editor.value, marketType: event.target.value as MarketType }, originalId: editor.originalId })}>{MARKET_TYPES.map((marketType) => <option key={marketType} value={marketType}>{MARKET_TYPE_LABELS[marketType]}</option>)}</select></label>
                <label className="form-field">Dirección del pronóstico<select value={editor.value.forecastType} onChange={(event) => setEditor({ kind: "market", value: { ...editor.value, forecastType: event.target.value as ForecastType }, originalId: editor.originalId })}>{FORECAST_TYPES.map((forecastType) => <option key={forecastType} value={forecastType}>{FORECAST_TYPE_LABELS[forecastType]}</option>)}</select></label>
                <label className="form-field">Equipo<select value={editor.value.team} onChange={(event) => setEditor({ kind: "market", value: { ...editor.value, team: event.target.value as MarketTeam }, originalId: editor.originalId })}>{MARKET_TEAMS.map((team) => <option key={team} value={team}>{MARKET_TEAM_LABELS[team]}</option>)}</select></label>
                <label className="form-field">Colchón base<input type="number" min="0" step="any" value={editor.value.baseCushion} aria-invalid={Boolean(editorErrors.baseCushion)} aria-describedby={editorErrors.baseCushion ? "editor-cushion-error" : undefined} onChange={(event) => setEditor({ kind: "market", value: { ...editor.value, baseCushion: event.target.value === "" ? Number.NaN : Number(event.target.value) }, originalId: editor.originalId })} />{editorErrors.baseCushion && <span className="field-error" id="editor-cushion-error">{editorErrors.baseCushion}</span>}</label>
              </> : <>
                <label className="form-field form-field-wide">Instrucciones<textarea rows={3} value={editor.value.instructions} maxLength={ANALYSIS_LIMITS.instructionsCharacters} aria-invalid={Boolean(editorErrors.instructions)} aria-describedby={editorErrors.instructions ? "editor-instructions-error" : undefined} onChange={(event) => setEditor({ kind: "rule", value: { ...editor.value, instructions: event.target.value }, originalId: editor.originalId })} />{editorErrors.instructions && <span className="field-error" id="editor-instructions-error">{editorErrors.instructions}</span>}</label>
                <label className="form-field">Factor de riesgo<input type="number" min="0" max="1" step="any" value={editor.value.riskFactor} aria-invalid={Boolean(editorErrors.riskFactor)} aria-describedby={editorErrors.riskFactor ? "editor-risk-error" : undefined} onChange={(event) => setEditor({ kind: "rule", value: { ...editor.value, riskFactor: event.target.value === "" ? Number.NaN : Number(event.target.value) }, originalId: editor.originalId })} />{editorErrors.riskFactor && <span className="field-error" id="editor-risk-error">{editorErrors.riskFactor}</span>}</label>
                <label className="form-field">Trigger<select value={editor.value.trigger} onChange={(event) => setEditor({ kind: "rule", value: { ...editor.value, trigger: event.target.value as RuleTrigger }, originalId: editor.originalId })}>{RULE_TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{TRIGGER_LABELS[trigger]}</option>)}</select></label>
              </>}
            </div>
            <button className="button button-primary" type="submit">Aplicar elemento</button>
          </form>}
          <footer className="drawer-footer"><button type="button" className="button button-secondary" onClick={closeConfiguration}>Cancelar cambios</button><button type="button" className="button button-primary" onClick={saveConfiguration} disabled={Boolean(editor)}>Guardar configuración</button></footer>
        </div>}
      </dialog>
    </main>
  );
}
