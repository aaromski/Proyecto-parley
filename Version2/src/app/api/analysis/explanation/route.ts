import { z } from "zod";
import { getMatchDetail } from "@/lib/server/football";
import { ApiError, apiErrorResponse, readJsonBody } from "@/lib/server/http";
import { buildEvidenceCatalog, explainEvidence, explanationLimitations } from "@/lib/server/explanations";

export const runtime = "nodejs";

const requestSchema = z.object({
  matchId: z.number().int().positive().max(999_999_999_999),
  window: z.enum(["season", "recent"]),
}).strict();

export async function POST(request: Request) {
  try {
    const parsed = requestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new ApiError(400, "INVALID_BODY", "Indica un partido y una ventana válidos.");
    const match = await getMatchDetail(parsed.data.matchId);
    const catalog = buildEvidenceCatalog(match, parsed.data.window);
    const statements = await explainEvidence(catalog);
    return Response.json({
      explanation: { generatedBy: "gemini", statements, limitations: explanationLimitations() },
      decision: null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}