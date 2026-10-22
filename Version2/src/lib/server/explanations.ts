import { ApiError } from "./http.ts";
import type { MatchDetail } from "./football.ts";

type Evidence = { id: string; kind: "metric" | "missing"; team: string; label?: string; value?: number; unit?: string; sampleSize?: number; window?: string };
type RenderedStatement = { evidenceId: string; text: string };
type ParlaySelectionSummary = {
  matchId: number;
  teamName: string;
  opponentName: string;
  marketName: string;
  selectionLabel: string;
  kickoff: string;
  competitionName?: string;
  verdict?: string;
};

function safeMetric(evidence: { status: string; value?: number; unit?: string; sampleSize?: number; window?: string }, team: string, label: string, id: string): Evidence | null {
  if ((evidence.status !== "derived" && evidence.status !== "observed") || typeof evidence.value !== "number" || !Number.isFinite(evidence.value)) return null;
  return { id, kind: "metric", team, label, value: evidence.value, unit: evidence.unit, sampleSize: evidence.sampleSize, window: evidence.window };
}

export function buildEvidenceCatalog(match: MatchDetail, window: "season" | "recent"): Evidence[] {
  const catalog: Evidence[] = [];
  for (const side of ["home", "away"] as const) {
    const comparison = match.teamComparisons[side];
    const stats = comparison[window];
    for (const [key, metric, label] of [
      ["gf", stats.goalsFor, "goles a favor por partido"],
      ["ga", stats.goalsAgainst, "goles en contra por partido"],
    ] as const) {
      const entry = safeMetric(metric, comparison.teamName, label, `${side}_${key}`);
      if (entry) catalog.push(entry);
    }
    if (!catalog.some((entry) => entry.team === comparison.teamName && entry.kind === "metric")) {
      catalog.push({ id: `${side}_history_unavailable`, kind: "missing", team: comparison.teamName });
    }
  }
  return catalog;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "La respuesta de explicación superó el límite permitido.");
  }
  if (!response.body) throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "La respuesta de explicación estaba vacía.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "La respuesta de explicación superó el límite permitido.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function renderStatement(evidence: Evidence): RenderedStatement {
  if (evidence.kind === "missing") {
    return { evidenceId: evidence.id, text: `No hay resultados históricos completos disponibles para ${evidence.team}.` };
  }
  const value = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(evidence.value ?? 0);
  const sample = evidence.sampleSize === undefined ? "" : ` en ${evidence.sampleSize} partidos`;
  const window = evidence.window ? ` (${evidence.window})` : "";
  return {
    evidenceId: evidence.id,
    text: `${evidence.team}: ${value} ${evidence.unit ?? ""} de ${evidence.label}${sample}${window}.`,
  };
}

export async function explainEvidence(catalog: Evidence[]): Promise<RenderedStatement[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "La explicación automática no está configurada.");
  const allowedIds = catalog.map((entry) => entry.id);
  const responseSchema = {
    type: "OBJECT",
    properties: { evidenceIds: { type: "ARRAY", items: { type: "STRING", enum: allowedIds }, maxItems: 8 } },
    required: ["evidenceIds"],
    additionalProperties: false,
  };
  let response: Response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ instruction: "Selecciona hasta ocho IDs de evidencia relevantes. Devuelve solo el objeto del esquema; no escribas frases ni métricas.", evidence: catalog }) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0, maxOutputTokens: 256 },
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new ApiError(504, "PROVIDER_TIMEOUT", "La explicación automática tardó demasiado.", true);
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "No se pudo obtener una explicación válida.", true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new ApiError(429, "RATE_LIMITED", "La explicación alcanzó su límite temporal.", true);
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "No se pudo obtener una explicación válida.", true);
  }

  const responseText = await readBoundedText(response, 16 * 1024);
  try {
    const payload = JSON.parse(responseText) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(rawText ?? "") as { evidenceIds?: unknown };
    const ids = parsed.evidenceIds;
    if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== "string" || !allowedIds.includes(id)) || new Set(ids).size !== ids.length) {
      throw new Error("Invalid evidence IDs");
    }
    const selected = new Set(ids as string[]);
    return catalog.filter((entry) => selected.has(entry.id)).map(renderStatement);
  } catch {
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "La respuesta de explicación no cumplió el formato permitido.");
  }
}

export function buildParlayEvidence(selections: ParlaySelectionSummary[]): RenderedStatement[] {
  return selections.map((selection, index) => ({
    evidenceId: `selection_${selection.matchId}_${index}`,
    text: `${selection.teamName} · ${selection.marketName} (${selection.selectionLabel}) frente a ${selection.opponentName}${selection.competitionName ? ` · ${selection.competitionName}` : ""}${selection.kickoff ? ` · ${new Date(selection.kickoff).toISOString()}` : ""}${selection.verdict ? ` · veredicto ${selection.verdict}` : ""}.`,
  }));
}

export async function explainParlaySelections(selections: ParlaySelectionSummary[]): Promise<RenderedStatement[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "La explicación automática de combinadas no está configurada.");
  const catalog = buildParlayEvidence(selections);
  if (!catalog.length) throw new ApiError(400, "INVALID_BODY", "La combinada no contiene selecciones válidas para explicar.");

  const responseSchema = {
    type: "OBJECT",
    properties: {
      statements: {
        type: "ARRAY",
        items: { type: "STRING" },
        minItems: 1,
        maxItems: Math.min(catalog.length, 6),
      },
    },
    required: ["statements"],
    additionalProperties: false,
  };

  let response: Response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ instruction: "Explica la combinada con máximo 6 frases breves, usando solo las selecciones entregadas. No inventes cuotas, probabilidades ni métricas que no estén en la evidencia. Si faltan datos, di claramente qué falta.", selections }) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0, maxOutputTokens: 256 },
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new ApiError(504, "PROVIDER_TIMEOUT", "La explicación automática de combinadas tardó demasiado.", true);
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "No se pudo obtener la explicación de la combinada.", true);
  }

  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new ApiError(429, "RATE_LIMITED", "La explicación de combinadas alcanzó su límite temporal.", true);
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "No se pudo obtener una explicación válida de la combinada.", true);
  }

  const responseText = await readBoundedText(response, 16 * 1024);
  try {
    const payload = JSON.parse(responseText) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(rawText ?? "") as { statements?: unknown };
    const statements = parsed.statements;
    if (!Array.isArray(statements) || statements.length === 0 || statements.length > Math.min(catalog.length, 6) || statements.some((entry) => typeof entry !== "string")) {
      throw new Error("Invalid parlay statements");
    }
    return statements.map((text, index) => ({ evidenceId: catalog[index]?.evidenceId ?? `selection_${index}`, text: String(text) }));
  } catch {
    throw new ApiError(502, "GEMINI_INVALID_OUTPUT", "La respuesta de explicación de combinadas no cumplió el formato permitido.");
  }
}

export function explanationLimitations(): string[] {
  return [
    "La explicación no asigna veredictos ni selecciones.",
    "xG, córners, métricas de portero, posesión, duelos y despejes no están disponibles en la fuente consultada.",
    "Los mercados sin regla y colchón base configurados permanecen no evaluables.",
  ];
}