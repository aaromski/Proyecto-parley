import {
  ANALYSIS_LIMITS,
  ContractValidationError,
  parseAnalysisRequest,
  type AnalysisResponse,
} from "@/lib/analysis-contract";
import {
  analyzeMatch,
  AnalysisServiceError,
} from "@/lib/analyze-match";

export const runtime = "nodejs";

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function analysisStream(
  payload: ReturnType<typeof parseAnalysisRequest>,
  apiKey: string,
  model: string | undefined,
): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const result: AnalysisResponse = await analyzeMatch(
            payload,
            apiKey,
            model,
            (stage) => {
              if (!cancelled) controller.enqueue(sseEvent("stage", { stage }));
            },
          );
          if (!cancelled) controller.enqueue(sseEvent("result", result));
        } catch (error) {
          if (!cancelled) {
            const failure =
              error instanceof AnalysisServiceError
                ? {
                    code: error.code,
                    message: "The requested analysis could not be completed.",
                    stage: error.stage,
                  }
                : {
                    code: "INTERNAL_ERROR",
                    message: "The requested analysis could not be completed.",
                    stage: "analysis",
                  };
            controller.enqueue(sseEvent("error", { error: failure }));
          }
        } finally {
          if (!cancelled) controller.close();
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  stage: "validation" | "normalization" | "analysis" | "configuration",
): Response {
  return Response.json({ error: { code, message, stage } }, { status });
}

async function readRequestBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > ANALYSIS_LIMITS.requestBytes) {
    throw new RangeError("Request body too large");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new ContractValidationError("A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > ANALYSIS_LIMITS.requestBytes) {
        await reader.cancel();
        throw new RangeError("Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ContractValidationError("The request body must contain valid JSON.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(
      503,
      "MISSING_API_KEY",
      "Analysis service configuration is missing.",
      "configuration",
    );
  }

  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return errorResponse(
      415,
      "INVALID_CONTENT_TYPE",
      "Content-Type must be application/json.",
      "validation",
    );
  }

  try {
    const payload = parseAnalysisRequest(await readRequestBody(request));
    const configuredModel = process.env.OPENROUTER_MODEL?.trim();
    const model = configuredModel && configuredModel.toLowerCase() !== "openrouter/auto"
      ? configuredModel
      : undefined;
    return analysisStream(payload, apiKey, model);
  } catch (error) {
    if (error instanceof RangeError) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "Request body is too large.", "validation");
    }
    if (error instanceof ContractValidationError) {
      return errorResponse(400, error.code, error.message, "validation");
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "The requested analysis could not be completed.",
      "analysis",
    );
  }
}