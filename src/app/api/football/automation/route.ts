import { timingSafeEqual } from "node:crypto";
import { errorMessage } from "@/lib/football/errors";
import { runAutomation } from "@/lib/football/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Cron endpoint called by cron-job.org every 15 minutes.
 * Contract (preserved): Authorization: Bearer <CRON_SECRET>.
 * No query-string secret is accepted.
 */

function isAuthorized(request: Request): { ok: boolean; reason?: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, reason: "CRON_SECRET is not configured" };
  }

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return { ok: false };
  }

  const received = Buffer.from(header.slice(prefix.length).trim());
  const expected = Buffer.from(secret);
  if (received.length !== expected.length) {
    return { ok: false };
  }
  return { ok: timingSafeEqual(new Uint8Array(received), new Uint8Array(expected)) };
}

async function handle(request: Request): Promise<Response> {
  const auth = isAuthorized(request);
  if (!auth.ok) {
    return Response.json(
      { ok: false, error: auth.reason ?? "Unauthorized" },
      { status: auth.reason ? 500 : 401 },
    );
  }

  try {
    const summary = await runAutomation();
    return Response.json({ ok: true, summary });
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
