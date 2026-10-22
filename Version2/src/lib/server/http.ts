import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server.js";

export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryable = false, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function apiErrorResponse(error: unknown): NextResponse {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(502, "PROVIDER_ERROR", "No se pudo completar la solicitud.", true);
  const headers = apiError.retryAfterSeconds ? { "Retry-After": String(apiError.retryAfterSeconds) } : undefined;
  return NextResponse.json({
    error: {
      code: apiError.code,
      message: apiError.message,
      retryable: apiError.retryable,
      requestId: randomUUID(),
    },
  }, { status: apiError.status, headers });
}

export async function readJsonBody(request: Request, limit = 8 * 1024): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "El cuerpo de la solicitud supera el límite permitido.");
  }
  if (!request.body) throw new ApiError(400, "INVALID_BODY", "Falta el cuerpo de la solicitud.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, "REQUEST_TOO_LARGE", "El cuerpo de la solicitud supera el límite permitido.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_BODY", "El cuerpo debe contener JSON válido.");
  }
}

export function validateOrBadRequest<T>(result: { success: boolean; data?: T }): T {
  if (!result.success || result.data === undefined) {
    throw new ApiError(400, "INVALID_QUERY", "Revisa los parámetros de la solicitud.");
  }
  return result.data;
}