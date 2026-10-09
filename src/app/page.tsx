import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  KeyRound,
  ListChecks,
  Megaphone,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  Trophy,
  XCircle,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { getDb, isDatabaseConfigured } from "@/lib/db";
import { apiBaseUrl, dailyBudget } from "@/lib/football/config";
import { loadDashboardData, type DashboardData } from "@/lib/football/store";

export const dynamic = "force-dynamic";

/* --------------------------------- helpers --------------------------------- */

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

const KIND_LABELS: Record<string, string> = {
  kickoff: "Kick-off",
  live_update: "Live Update",
  lineup: "Starting XI",
  goal: "Goal",
  own_goal: "Own Goal",
  penalty_goal: "Penalty",
  missed_penalty: "Missed Pen",
  yellow_card: "Yellow",
  red_card: "Red",
  substitution: "Sub",
  var: "VAR",
  incident: "Incident",
  halftime: "Half-time",
  second_half: "2nd Half",
  extra_time: "Extra Time",
  extra_time_break: "ET Break",
  penalty_shootout: "Shootout",
  shootout_update: "Shootout",
  fulltime: "Full-time",
  postponed: "Postponed",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
  suspended: "Suspended",
  interrupted: "Interrupted",
  awarded: "Awarded",
  walkover: "Walkover",
  status_generic: "Status",
};

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  posted: { label: "Posted", className: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30" },
  failed: { label: "Failed", className: "bg-rose-400/10 text-rose-300 ring-rose-400/30" },
  claimed: { label: "Claimed", className: "bg-amber-400/10 text-amber-300 ring-amber-400/30" },
  blocked: { label: "Queued (auth)", className: "bg-orange-400/10 text-orange-300 ring-orange-400/30" },
};

const RUN_STATUS_STYLES: Record<string, string> = {
  success: "text-emerald-300",
  partial: "text-amber-300",
  failed: "text-rose-300",
  skipped: "text-sky-300",
  running: "text-neutral-300",
};

/* ------------------------------- components -------------------------------- */

type Icon = ComponentType<{ className?: string }>;

function StatCard(props: { icon: Icon; label: string; value: string; sub?: string; accent: string }) {
  const IconComponent = props.icon;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">
        <IconComponent className={`h-4 w-4 ${props.accent}`} />
        {props.label}
      </div>
      <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">{props.value}</div>
      {props.sub ? <div className="mt-1 text-xs text-neutral-500">{props.sub}</div> : null}
    </div>
  );
}

function SectionTitle(props: { icon: Icon; title: string; hint?: string }) {
  const IconComponent = props.icon;
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-neutral-300">
        <IconComponent className="h-4 w-4 text-lime-300" />
        {props.title}
      </h2>
      {props.hint ? <span className="text-xs text-neutral-500">{props.hint}</span> : null}
    </div>
  );
}

function Panel(props: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-2xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm ${props.className ?? ""}`}
    >
      {props.children}
    </section>
  );
}

function ConfigRow(props: { name: string; ok: boolean; note: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <code className="block truncate font-mono text-sm text-neutral-200">{props.name}</code>
        <span className="text-xs text-neutral-500">{props.note}</span>
      </div>
      {props.ok ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-300">
          <CheckCircle2 className="h-4 w-4" /> set
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-rose-300">
          <XCircle className="h-4 w-4" /> missing
        </span>
      )}
    </li>
  );
}

/* ----------------------------------- page ----------------------------------- */

export default async function DashboardPage() {
  let data: DashboardData | null = null;
  let databaseError: string | null = null;

  if (isDatabaseConfigured()) {
    try {
      data = await loadDashboardData(getDb());
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
    }
  } else {
    databaseError = "DATABASE_URL is not configured";
  }

  const budget = dailyBudget();
  const usageTotal = data?.usage?.total ?? 0;
  const usagePercent = Math.min(100, Math.round((usageTotal / budget) * 100));

  const configChecks = [
    { name: "DATABASE_URL", ok: Boolean(process.env.DATABASE_URL), note: "Neon PostgreSQL connection" },
    { name: "FOOTBALL_API_KEY", ok: Boolean(process.env.FOOTBALL_API_KEY), note: "API-Football secret" },
    {
      name: "FOOTBALL_API_BASE_URL",
      ok: true,
      note: apiBaseUrl() + (process.env.FOOTBALL_API_BASE_URL ? "" : " (default)"),
    },
    { name: "FACEBOOK_PAGE_ID", ok: Boolean(process.env.FACEBOOK_PAGE_ID), note: "DynaSport Page id" },
    {
      name: "FACEBOOK_PAGE_ACCESS_TOKEN",
      ok: Boolean(process.env.FACEBOOK_PAGE_ACCESS_TOKEN),
      note: "Page access token",
    },
    { name: "FACEBOOK_APP_ID", ok: Boolean(process.env.FACEBOOK_APP_ID), note: "Meta app id" },
    { name: "FACEBOOK_APP_SECRET", ok: Boolean(process.env.FACEBOOK_APP_SECRET), note: "Meta app secret" },
    { name: "CRON_SECRET", ok: Boolean(process.env.CRON_SECRET), note: "Bearer secret for the cron endpoint" },
  ];
  const configuredCount = configChecks.filter((c) => c.ok).length;

  return (
    <main className="grid-texture min-h-screen">
      <div className="mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-8">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-lime-400/15 ring-1 ring-lime-300/40">
              <Radio className="h-6 w-6 text-lime-300" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                Dyna<span className="text-lime-300">Sport</span>
              </h1>
              <p className="text-sm text-neutral-400">
                Live football automation · API-Football → Neon → Facebook Page
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 text-right">
            <span className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 font-mono text-xs text-neutral-300 ring-1 ring-white/10">
              <ShieldCheck className="h-3.5 w-3.5 text-lime-300" />
              GET /api/football/automation
            </span>
            <span className="font-mono text-[11px] text-neutral-500">
              Authorization: Bearer · every 15 minutes · cron-job.org
            </span>
          </div>
        </header>

        {/* Database warning */}
        {databaseError ? (
          <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              <span className="font-semibold">Database not reachable.</span> Connect Neon PostgreSQL
              via <code className="font-mono">DATABASE_URL</code> to activate live monitoring.
              {databaseError !== "DATABASE_URL is not configured" ? (
                <span className="block mt-1 text-xs text-amber-200/70">{databaseError}</span>
              ) : null}
            </p>
          </div>
        ) : null}

        {/* Facebook authentication problem - the single most important alert */}
        {data?.lastFacebookAuthError ? (
          <div className="mt-6 flex items-start gap-3 rounded-2xl border border-rose-400/40 bg-rose-400/10 p-4 text-sm text-rose-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
            <div className="min-w-0">
              <p className="font-semibold">
                Facebook publishing is paused — the Page access token was rejected.
              </p>
              <p className="mt-1 break-words text-xs text-rose-200/80">
                {data.lastFacebookAuthError.detail} · {timeAgo(data.lastFacebookAuthError.at)}
              </p>
              <p className="mt-1.5 text-xs text-rose-200/70">
                {data.blockedEvents} event(s) stay queued and will be delivered automatically once a
                valid <code className="font-mono">FACEBOOK_PAGE_ACCESS_TOKEN</code> is configured.
                Generate a long-lived Page token (long-lived user token → <code className="font-mono">/me/accounts</code>).
              </p>
            </div>
          </div>
        ) : null}

        {/* API-Football problem */}
        {data?.lastApiError ? (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="font-semibold">API-Football reported a problem.</p>
              <p className="mt-1 break-words text-xs text-amber-200/80">
                {data.lastApiError.detail} · {timeAgo(data.lastApiError.at)}
              </p>
            </div>
          </div>
        ) : null}

        {/* Stats */}
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">
              <Gauge className="h-4 w-4 text-lime-300" />
              API budget today
            </div>
            <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">
              {usageTotal}
              <span className="text-base font-normal text-neutral-500">/{budget}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full ${usagePercent > 90 ? "bg-rose-400" : "bg-lime-400"}`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              {data?.usage ? `${data.usage.heartbeat} heartbeat · ${data.usage.detail} detail` : "free plan · 100/day hard cap"}
            </div>
          </div>
          <StatCard
            icon={Activity}
            label="Eligible live"
            value={data ? String(data.liveNow) : "—"}
            sub="Tier 1 fixtures tracked (last 30 min)"
            accent="text-lime-300"
          />
          <StatCard
            icon={Send}
            label="Posted today"
            value={data ? String(data.postedToday) : "—"}
            sub={data ? `${data.postedTotal} total Facebook posts` : undefined}
            accent="text-emerald-300"
          />
          <StatCard
            icon={AlertTriangle}
            label="Retry queue"
            value={data ? String(data.failedEvents + data.blockedEvents) : "—"}
            sub={
              data
                ? `${data.failedEvents} failed · ${data.blockedEvents} awaiting token`
                : "retryable, never lost"
            }
            accent="text-rose-300"
          />
        </div>

        {/* Freshness / integrity strip */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-neutral-400">
            <Activity className="h-4 w-4 shrink-0 text-lime-300" />
            Last heartbeat:{" "}
            <span className="font-medium text-neutral-200">{timeAgo(data?.lastHeartbeatAt ?? null)}</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-neutral-400">
            <Send className="h-4 w-4 shrink-0 text-emerald-300" />
            Last Facebook post:{" "}
            <span className="font-medium text-neutral-200">{timeAgo(data?.lastDeliveryAt ?? null)}</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-neutral-400">
            <Trophy className="h-4 w-4 shrink-0 text-amber-300" />
            Unconfirmed finishes:{" "}
            <span className="font-medium text-neutral-200">{data ? data.unresolvedFixtures : "—"}</span>
          </div>
        </div>

        {/* Runs + events */}
        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          <Panel className="lg:col-span-2">
            <SectionTitle icon={ListChecks} title="Automation runs" hint="latest 12" />
            {!data || data.runs.length === 0 ? (
              <p className="py-8 text-center text-sm text-neutral-500">
                No runs recorded yet. The first cron call will appear here.
              </p>
            ) : (
              <ul className="divide-y divide-white/5">
                {data.runs.map((run) => {
                  const s = (run.summary ?? {}) as Record<string, unknown>;
                  const bits: string[] = [];
                  if (typeof s.liveFixtures === "number") bits.push(`${s.liveFixtures} live`);
                  if (typeof s.candidates === "number" && s.candidates > 0) bits.push(`${s.candidates} events`);
                  if (typeof s.posted === "number" && s.posted > 0) bits.push(`${s.posted} posted`);
                  if (typeof s.eligibleFixtures === "number") {
                    bits.push(`${s.eligibleFixtures} eligible`);
                  }
                  if (typeof s.excludedFixtures === "number" && s.excludedFixtures > 0) {
                    bits.push(`${s.excludedFixtures} excluded`);
                  }
                  if (s.facebookAuthBlocked === true) bits.push("token rejected");
                  if (s.bootstrapBaseline === true) bits.push("baseline");
                  return (
                    <li key={run.id} className="py-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className={`text-xs font-semibold uppercase tracking-wider ${RUN_STATUS_STYLES[run.status] ?? "text-neutral-300"}`}>
                          {run.status}
                        </span>
                        <span className="font-mono text-[11px] text-neutral-500" title={formatTime(run.startedAt)}>
                          {timeAgo(run.startedAt)}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-neutral-300">
                        {bits.length > 0 ? bits.join(" · ") : "heartbeat received"}
                      </div>
                      {run.error ? (
                        <div className="mt-1 truncate text-xs text-rose-300/80">{run.error}</div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel className="lg:col-span-3">
            <SectionTitle icon={Megaphone} title="Facebook delivery" hint="latest 25 events" />
            {!data || data.events.length === 0 ? (
              <p className="py-8 text-center text-sm text-neutral-500">
                No match events yet. Goals, cards and full-time results will stream in here.
              </p>
            ) : (
              <ul className="divide-y divide-white/5">
                {data.events.map((event) => {
                  const style = STATUS_STYLES[event.status] ?? STATUS_STYLES.claimed;
                  return (
                    <li key={event.eventKey} className="py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-lime-400/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-lime-300 ring-1 ring-lime-300/20">
                          {KIND_LABELS[event.kind] ?? event.kind}
                        </span>
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ${style.className}`}>
                          {style.label}
                        </span>
                        <span className="ml-auto font-mono text-[11px] text-neutral-500" title={formatTime(event.postedAt ?? event.updatedAt)}>
                          {timeAgo(event.postedAt ?? event.updatedAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-sm leading-snug text-neutral-300">
                        {event.message}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-neutral-500">
                        <span className="flex items-center gap-1 font-mono">
                          <Trophy className="h-3 w-3" /> fx{event.fixtureId}
                        </span>
                        {event.attempts > 1 ? <span>attempt {event.attempts}</span> : null}
                        {event.lastError ? (
                          <span className="truncate text-rose-300/80">{event.lastError}</span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        {/* Configuration */}
        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          <Panel className="lg:col-span-3">
            <SectionTitle
              icon={Settings2}
              title="Environment"
              hint={`${configuredCount}/${configChecks.length} configured`}
            />
            <ul className="divide-y divide-white/5">
              {configChecks.map((check) => (
                <ConfigRow key={check.name} name={check.name} ok={check.ok} note={check.note} />
              ))}
            </ul>
          </Panel>

          <Panel className="lg:col-span-2">
            <SectionTitle icon={KeyRound} title="Pipeline" hint="production contract" />
            <ul className="space-y-3 text-sm text-neutral-300">
              {[
                "15-minute heartbeat: /fixtures?live=all, filtered to the Tier 1 allowlist",
                "Tier 2 / low-interest competitions are excluded before any processing",
                "Starting XI from real API lineup data when the budget allows",
                "Deterministic event keys + atomic Neon claims prevent duplicate posts",
                "Failed Facebook posts stay retryable - never marked as posted",
                "Data-only posts \u2014 no commentary, no corners and no hashtags",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-lime-300" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2.5 text-xs text-neutral-400 ring-1 ring-white/10">
              <Database className="h-4 w-4 shrink-0 text-lime-300" />
              Neon PostgreSQL only · no local database fallback
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2.5 text-xs text-neutral-400 ring-1 ring-white/10">
              <Clock3 className="h-4 w-4 shrink-0 text-lime-300" />
              100 requests/day free-plan budget, enforced atomically in Neon
            </div>
          </Panel>
        </div>

        <footer className="mt-10 border-t border-white/10 pt-6 text-center text-xs text-neutral-600">
          DynaSport · live football events for the DynaSport Facebook Page
        </footer>
      </div>
    </main>
  );
}
