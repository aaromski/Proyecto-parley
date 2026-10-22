import { z } from "zod";
import { ApiError, apiErrorResponse } from "@/lib/server/http";
import { getMatchDetail } from "@/lib/server/football";

export const runtime = "nodejs";

const idSchema = z.string().regex(/^[1-9]\d{0,11}$/).transform(Number);

export async function GET(_request: Request, context: { params: Promise<{ matchId: string }> }) {
  try {
    const { matchId } = await context.params;
    const parsed = idSchema.safeParse(matchId);
    if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "El identificador del partido no es válido.");
    const detail = await getMatchDetail(parsed.data);
    return Response.json({ match: detail, metrics: detail.metrics, teamComparisons: detail.teamComparisons }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}