import { ApiError } from "./http.ts";
import { createRequestPacer, FOOTBALL_MAX_DAYS_PER_REQUEST, FOOTBALL_MIN_REQUEST_INTERVAL_MS, getRetryDelaySeconds, splitUtcDateRange } from "./football-api-limits.ts";

const API_ROOT = "https://api.football-data.org/v4";
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_FIXTURE_PAGES = 10;
const paceProviderRequest = createRequestPacer(FOOTBALL_MIN_REQUEST_INTERVAL_MS);

export type TeamRef = { id: number; name: string; shortName: string | null };
export type MatchSummary = {
  id: number;
  season: number;
  competition: { id: number; name: string; code: string | null } | null;
  kickoff: string;
  status: string;
  homeTeam: TeamRef;
  awayTeam: TeamRef;
};
export type MetricAvailability =
  | { status: "derived"; value: number; unit: string; formula: string; inputs: string[]; sampleSize: number; window: string }
  | { status: "unavailable"; reason: "not_provided" | "not_covered" | "insufficient_data" };
export type TeamWindow = {
  sampleSize: number;
  window: string;
  goalsFor: MetricAvailability;
  goalsAgainst: MetricAvailability;
};
export type TeamComparison = {
  teamId: number;
  teamName: string;
  season: TeamWindow;
  recent: TeamWindow;
  results: Array<{ id: number; kickoff: string; opponent: string; goalsFor: number; goalsAgainst: number; outcome: "victoria" | "empate" | "derrota" }>;
};
export type MatchDetail = MatchSummary & {
  score: { home: number | null; away: number | null };
  goals: Array<{ minute: number | null; teamId: number | null; scorer: string | null }> | null;
  lastUpdated: string | null;
  metrics: Record<string, MetricAvailability>;
  teamComparisons: { home: TeamComparison; away: TeamComparison };
};

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function responseJson(response: Response, limit = RESPONSE_LIMIT): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "La fuente devolvió una respuesta demasiado grande.", true);
  }
  if (!response.body) throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "La fuente devolvió una respuesta vacía.", true);

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
        throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "La fuente devolvió una respuesta demasiado grande.", true);
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
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "La fuente devolvió datos no válidos.", true);
  }
}

async function providerJson(path: string): Promise<unknown> {
  const token = process.env.FOOTBALL_API_KEY;
  if (!token) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "La fuente de partidos no está configurada.");
  await paceProviderRequest();
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      cache: "no-store",
      headers: { "X-Auth-Token": token, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ApiError(504, "PROVIDER_TIMEOUT", "La fuente de partidos tardó demasiado en responder.", true);
    }
    throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "No se pudo conectar con la fuente de partidos.", true);
  }

  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      const retryAfterSeconds = getRetryDelaySeconds(response.headers.get("Retry-After"), response.headers.get("X-RequestCounter-Reset"));
      paceProviderRequest.defer(retryAfterSeconds * 1000);
      throw new ApiError(429, "RATE_LIMITED", "La fuente alcanzó su límite temporal.", true, retryAfterSeconds);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(503, "SOURCE_COVERAGE_UNAVAILABLE", "La fuente no permite consultar esta cobertura.");
    }
    if (response.status >= 500) throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "La fuente de partidos no está disponible.", true);
    throw new ApiError(502, "FOOTBALL_PROVIDER_ERROR", "La fuente no pudo completar la consulta.", true);
  }
  return responseJson(response);
}

function mapTeam(value: unknown): TeamRef | null {
  const team = readObject(value);
  if (!Number.isInteger(team.id) || Number(team.id) <= 0 || typeof team.name !== "string") return null;
  return { id: Number(team.id), name: team.name, shortName: typeof team.shortName === "string" ? team.shortName : null };
}

export function mapMatch(value: unknown): MatchSummary | null {
  const match = readObject(value);
  const season = readObject(match.season);
  const competition = readObject(match.competition);
  const homeTeam = mapTeam(match.homeTeam);
  const awayTeam = mapTeam(match.awayTeam);
  const kickoff = typeof match.utcDate === "string" ? match.utcDate : "";
  const seasonYear = typeof season.startDate === "string" ? Number(season.startDate.slice(0, 4)) : NaN;
  if (!Number.isInteger(match.id) || Number(match.id) <= 0 || !Number.isInteger(seasonYear) || !Number.isFinite(Date.parse(kickoff)) || !homeTeam || !awayTeam || typeof match.status !== "string") return null;
  return {
    id: Number(match.id),
    season: seasonYear,
    competition: Number.isInteger(competition.id) && typeof competition.name === "string"
      ? { id: Number(competition.id), name: competition.name, code: typeof competition.code === "string" ? competition.code : null }
      : null,
    kickoff,
    status: match.status,
    homeTeam,
    awayTeam,
  };
}

function currentInstant(): Date {
  return new Date();
}

export async function listUpcomingMatches(input: { season: number; from: Date; to: Date; query: string }) {
  const now = currentInstant();
  const from = input.from > now ? input.from : now;
  if (from >= input.to) return { matches: [], coverage: "unknown" as const, source: "football-data.org" as const, season: input.season, requestedRange: { from: input.from.toISOString(), to: input.to.toISOString() } };

  const collected: unknown[] = [];
  for (const window of splitUtcDateRange(from, input.to, FOOTBALL_MAX_DAYS_PER_REQUEST)) {
    const params = new URLSearchParams({
      dateFrom: window.from,
      dateTo: window.to,
      season: String(input.season),
      limit: String(PAGE_SIZE),
    });
    let windowCount = 0;
    let totalCount: number | null = null;
    for (let page = 0; page < MAX_FIXTURE_PAGES; page += 1) {
      params.set("offset", String(page * PAGE_SIZE));
      const payload = readObject(await providerJson(`/matches?${params.toString()}`));
      const resultSet = readObject(payload.resultSet);
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      totalCount = Number.isInteger(resultSet.count) && Number(resultSet.count) >= 0 ? Number(resultSet.count) : null;
      collected.push(...matches);
      windowCount += matches.length;
      if (matches.length < PAGE_SIZE || totalCount === null || windowCount >= totalCount) break;
      if (page === MAX_FIXTURE_PAGES - 1) {
        throw new ApiError(503, "SOURCE_COVERAGE_UNAVAILABLE", "La consulta supera el límite seguro de resultados.");
      }
    }
  }

  const nowMs = now.getTime();
  const needle = input.query.trim().toLocaleLowerCase("es");
  const matches = collected
    .map(mapMatch)
    .filter((match): match is MatchSummary => Boolean(match))
    .filter((match) => match.season === input.season && Date.parse(match.kickoff) >= nowMs && Date.parse(match.kickoff) <= input.to.getTime())
    .filter((match) => !["IN_PLAY", "PAUSED", "FINISHED", "SUSPENDED", "CANCELLED", "POSTPONED"].includes(match.status))
    .filter((match) => !needle || `${match.homeTeam.name} ${match.awayTeam.name} ${match.competition?.name ?? ""}`.toLocaleLowerCase("es").includes(needle))
    .sort((left, right) => Date.parse(left.kickoff) - Date.parse(right.kickoff));
  return {
    matches,
    coverage: matches.length ? "available" as const : "unknown" as const,
    source: "football-data.org" as const,
    season: input.season,
    requestedRange: { from: input.from.toISOString(), to: input.to.toISOString() },
  };
}

const unavailable: MetricAvailability = { status: "unavailable", reason: "not_provided" };

function readScore(match: Record<string, unknown>) {
  const score = readObject(readObject(match.score).fullTime);
  return {
    home: Number.isInteger(score.home) && Number(score.home) >= 0 ? Number(score.home) : null,
    away: Number.isInteger(score.away) && Number(score.away) >= 0 ? Number(score.away) : null,
  };
}

async function getTeamComparison(team: TeamRef, opponent: TeamRef, seasonYear: number): Promise<TeamComparison> {
  const basePath = `/teams/${team.id}/matches?season=${seasonYear}&status=FINISHED&limit=${PAGE_SIZE}`;
  try {
    const firstPayload = readObject(await providerJson(basePath));
    const firstSet = readObject(firstPayload.resultSet);
    const total = Number.isInteger(firstSet.count) && Number(firstSet.count) >= 0 ? Number(firstSet.count) : null;
    let rawMatches = Array.isArray(firstPayload.matches) ? firstPayload.matches : [];
    let latestSetComplete = total !== null && total <= rawMatches.length;
    if (total !== null && total > rawMatches.length) {
      const offset = Math.max(0, total - PAGE_SIZE);
      const latestPayload = readObject(await providerJson(`${basePath}&offset=${offset}`));
      rawMatches = Array.isArray(latestPayload.matches) ? latestPayload.matches : [];
      latestSetComplete = rawMatches.length > 0;
    }

    const records = rawMatches.map((raw) => {
      const value = readObject(raw);
      const summary = mapMatch(value);
      const score = readScore(value);
      if (!summary || score.home === null || score.away === null) return null;
      const isHome = summary.homeTeam.id === team.id;
      if (!isHome && summary.awayTeam.id !== team.id) return null;
      return {
        id: summary.id,
        kickoff: summary.kickoff,
        opponent: isHome ? summary.awayTeam.name : summary.homeTeam.name,
        goalsFor: isHome ? score.home : score.away,
        goalsAgainst: isHome ? score.away : score.home,
      };
    }).filter((record): record is NonNullable<typeof record> => record !== null)
      .sort((left, right) => Date.parse(left.kickoff) - Date.parse(right.kickoff));

    const makeWindow = (selected: typeof records, label: string, complete: boolean): TeamWindow => {
      if (!selected.length || !complete) {
        const unavailableReason = selected.length ? "insufficient_data" as const : "not_covered" as const;
        const missing: MetricAvailability = { status: "unavailable", reason: unavailableReason };
        return { sampleSize: selected.length, window: label, goalsFor: missing, goalsAgainst: missing };
      }
      const goalsFor = selected.reduce((sum, record) => sum + record.goalsFor, 0);
      const goalsAgainst = selected.reduce((sum, record) => sum + record.goalsAgainst, 0);
      const observedInputs = selected.map((record) => `match:${record.id}`);
      const derived = (value: number, unit: string, formula: string): MetricAvailability => ({
        status: "derived", value, unit, formula, inputs: observedInputs, sampleSize: selected.length, window: label,
      });
      return {
        sampleSize: selected.length,
        window: label,
        goalsFor: derived(goalsFor / selected.length, "goles/partido", "suma de goles a favor / partidos completos"),
        goalsAgainst: derived(goalsAgainst / selected.length, "goles/partido", "suma de goles en contra / partidos completos"),
      };
    };

    const recentWindow = records.length
      ? `Últimos partidos disponibles: ${records[0].kickoff.slice(0, 10)} a ${records.at(-1)!.kickoff.slice(0, 10)}`
      : "Sin resultados finalizados disponibles";
    const recent = makeWindow(records, recentWindow, latestSetComplete && records.length === rawMatches.length);
    const seasonComplete = total !== null && total <= PAGE_SIZE && records.length === rawMatches.length;
    const season = makeWindow(records, `Temporada ${seasonYear}`, seasonComplete);
    const results = records.map((record) => ({
      ...record,
      outcome: record.goalsFor > record.goalsAgainst ? "victoria" as const : record.goalsFor === record.goalsAgainst ? "empate" as const : "derrota" as const,
    }));
    return { teamId: team.id, teamName: team.name, season, recent, results };
  } catch {
    const missing: TeamWindow = {
      sampleSize: 0,
      window: "Historial no disponible",
      goalsFor: { status: "unavailable", reason: "not_covered" },
      goalsAgainst: { status: "unavailable", reason: "not_covered" },
    };
    return { teamId: team.id, teamName: team.name, season: missing, recent: missing, results: [] };
  }
}

export async function getMatchDetail(matchId: number): Promise<MatchDetail> {
  const payload = readObject(await providerJson(`/matches/${matchId}`));
  const match = mapMatch(payload);
  if (!match) throw new ApiError(404, "MATCH_NOT_FOUND", "No encontramos ese partido en la fuente.");
  const score = readScore(payload);
  const goalsRaw = Array.isArray(payload.goals) ? payload.goals : null;
  const goals = goalsRaw?.map((raw) => {
    const goal = readObject(raw);
    const team = readObject(goal.team);
    const scorer = readObject(goal.scorer);
    return {
      minute: Number.isInteger(goal.minute) ? Number(goal.minute) : null,
      teamId: Number.isInteger(team.id) ? Number(team.id) : null,
      scorer: typeof scorer.name === "string" ? scorer.name : null,
    };
  }) ?? null;
  const [homeComparison, awayComparison] = await Promise.all([
    getTeamComparison(match.homeTeam, match.awayTeam, match.season),
    getTeamComparison(match.awayTeam, match.homeTeam, match.season),
  ]);
  return {
    ...match,
    score,
    goals,
    lastUpdated: typeof payload.lastUpdated === "string" ? payload.lastUpdated : null,
    metrics: {
      goals_for: unavailable,
      goals_against: unavailable,
      expected_goals: unavailable,
      goalkeeper_metrics: unavailable,
      possession: unavailable,
      duels: unavailable,
      clearances: unavailable,
      corners: unavailable,
      odds: unavailable,
    },
    teamComparisons: { home: homeComparison, away: awayComparison },
  };
}