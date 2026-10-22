import { z } from "zod";
import { ApiError, apiErrorResponse } from "@/lib/server/http";
import { listUpcomingMatches } from "@/lib/server/football";

export const runtime = "nodejs";

const querySchema = z.object({
  season: z.string().regex(/^\d{4}$/).transform(Number),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  q: z.string().trim().min(1).max(80).optional(),
}).strict();

export async function GET(request: Request) {
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "Indica temporada, intervalo y búsqueda válidos.");
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    const duration = to.getTime() - from.getTime();
    if (duration <= 0 || duration > 31 * 24 * 60 * 60 * 1000) {
      throw new ApiError(400, "INVALID_QUERY", "El intervalo debe ser futuro y no superar 31 días.");
    }
    return Response.json(await listUpcomingMatches({
      season: parsed.data.season,
      from,
      to,
      query: parsed.data.q ?? "",
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}