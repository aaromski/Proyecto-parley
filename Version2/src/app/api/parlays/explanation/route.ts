import { z } from "zod";
import { areSelectionsContradictory, MARKET_DEFINITIONS, type MarketId } from "@/lib/analysis";
import { explainParlaySelections } from "@/lib/server/explanations";
import { getMatchDetail } from "@/lib/server/football";
import { ApiError, apiErrorResponse, readJsonBody } from "@/lib/server/http";

export const runtime = "nodejs";

const requestSchema = z.object({
  selections: z.array(z.object({
    matchId: z.number().int().positive().max(999_999_999_999),
    marketId: z.enum(MARKET_DEFINITIONS.map((market) => market.id) as [MarketId, ...MarketId[]]),
    selectionId: z.string().min(1).max(80),
  }).strict()).min(1).max(4),
}).strict();

const selectionTeams: Record<string, "home" | "away"> = {
  home: "home",
  away: "away",
  home_or_draw: "home",
  away_or_draw: "away",
};

const selectionLabels: Record<string, string> = {
  home: "victoria local",
  away: "victoria visitante",
  home_or_draw: "local o empate",
  away_or_draw: "visitante o empate",
  match: "apuesta al resultado del partido",
};

export async function POST(request: Request) {
  try {
    const parsed = requestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new ApiError(400, "INVALID_BODY", "La combinada debe contener de una a cuatro selecciones válidas.");

    const details = await Promise.all(parsed.data.selections.map((selection) => getMatchDetail(selection.matchId)));
    const teamIds: number[] = [];
    const resolvedSelections = parsed.data.selections.map((selection, index) => {
      const side = selectionTeams[selection.selectionId];
      if (!side) throw new ApiError(422, "SELECTION_NOT_APPROVED", "No se pudo resolver el equipo de una selección.");
      const team = details[index][side === "home" ? "homeTeam" : "awayTeam"];
      return { ...selection, teamId: team.id, teamName: team.name, opponentName: details[index][side === "home" ? "awayTeam" : "homeTeam"].name };
    });

    parsed.data.selections.forEach((selection, index) => {
      const side = selectionTeams[selection.selectionId];
      if (!side) throw new ApiError(422, "SELECTION_NOT_APPROVED", "No se pudo resolver el equipo de una selección.");
      const teamId = details[index][side === "home" ? "homeTeam" : "awayTeam"].id;
      if (teamIds.includes(teamId)) throw new ApiError(409, "DUPLICATE_TEAM", "La combinada no puede repetir un equipo.");
      teamIds.push(teamId);
    });

    for (let index = 0; index < resolvedSelections.length; index += 1) {
      for (const prior of resolvedSelections.slice(0, index)) {
        if (areSelectionsContradictory(resolvedSelections[index], prior)) {
          throw new ApiError(409, "SELECTION_CONFLICT", "La combinada contiene selecciones contradictorias.");
        }
      }
    }

    const selectedDetails = resolvedSelections.map((selection, index) => ({
      matchId: selection.matchId,
      teamName: selection.teamName,
      opponentName: selection.opponentName,
      marketName: MARKET_DEFINITIONS.find((market) => market.id === selection.marketId)?.name ?? "Mercado" ,
      selectionLabel: selectionLabels[selection.selectionId] ?? "selección",
      kickoff: details[index].kickoff,
      competitionName: details[index].competition?.name ?? "Competición no disponible",
    }));

    const statements = await explainParlaySelections(selectedDetails);
    return Response.json({ explanation: { generatedBy: "gemini", statements, limitations: [
      "La explicación no asigna veredictos ni cuotas.",
      "La combinada solo resume las selecciones validadas y sus límites evidenciales.",
      "Si faltan datos o una regla no está aprobada, se indican como limitaciones y no se inventan métricas.",
    ] } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}