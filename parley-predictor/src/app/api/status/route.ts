export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ configured: Boolean(process.env.GEMINI_API_KEY?.trim()) });
}