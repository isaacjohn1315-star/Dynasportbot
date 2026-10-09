import { getDb, isDatabaseConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Operational health for DynaSport. Reports only what is actually verified:
 * the database is probed with a real query, while API-Football and Facebook
 * are reported as "configured" (credential validity can only be proven by a
 * real call, which would consume quota / publish a post).
 * No secret values are ever returned.
 */
export async function GET(): Promise<Response> {
  let database: "ok" | "error" | "not_configured" = "not_configured";
  let databaseError: string | null = null;

  if (isDatabaseConfigured()) {
    try {
      const sql = getDb();
      await sql`select 1 as ok`;
      database = "ok";
    } catch (error) {
      database = "error";
      databaseError = error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    }
  }

  const config = {
    databaseUrl: Boolean(process.env.DATABASE_URL),
    footballApiKey: Boolean(process.env.FOOTBALL_API_KEY),
    footballApiBaseUrl: Boolean(process.env.FOOTBALL_API_BASE_URL),
    facebookPageId: Boolean(process.env.FACEBOOK_PAGE_ID),
    facebookPageAccessToken: Boolean(process.env.FACEBOOK_PAGE_ACCESS_TOKEN),
    facebookAppId: Boolean(process.env.FACEBOOK_APP_ID),
    facebookAppSecret: Boolean(process.env.FACEBOOK_APP_SECRET),
    cronSecret: Boolean(process.env.CRON_SECRET),
  };

  const missing = Object.entries(config)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  /**
   * `ok` is a liveness signal: the service is running and able to answer.
   * Integration health is reported truthfully but separately in `status`,
   * so a missing credential surfaces as "degraded" instead of pretending
   * everything works - and without taking the deployment down.
   */
  const status: "ok" | "degraded" = database === "ok" && missing.length === 0 ? "ok" : "degraded";

  return Response.json({
    ok: true,
    status,
    app: "dynasport",
    time: new Date().toISOString(),
    database,
    databaseError,
    config,
    missingConfig: missing,
  });
}
