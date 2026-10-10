export type GraphMode = "ok" | "accept-timeout" | "reject-timeout" | "auth";

interface Row {
  fixtureId: number;
  kind: string;
  message: string;
  status: string;
  attempts: number;
  parentKey: string | null;
  updatedAt: string;
  fbPostId: string | null;
}

const MEMBER_KINDS = new Set([
  "goal", "penalty_goal", "own_goal", "missed_penalty", "yellow_card", "red_card",
  "substitution", "var_red_upgrade", "var_goal_disallowed", "var_goal_awarded",
  "var_penalty_awarded", "var_penalty_overturned", "var_review",
]);

export function makeHarness() {
  const sentPosts: string[] = [];
  const pageFeed: Array<{ id: string; message: string; created_time: string }> = [];
  const rows = new Map<string, Row>();
  const saved = new Map<number, unknown>();
  let usage = 0;
  let detailCount = 0;
  let live: unknown[] = [];
  let detail: unknown[] = [];
  let graphMode: GraphMode = "ok";
  let failPostedAckOnce = false;

  const nowOld = () => new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const findKey = (values: unknown[]) => values.find((v) => typeof v === "string" && rows.has(v)) as string | undefined;

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").toLowerCase().trim();
    if (/^(create|alter|create index|delete|insert into system_events|insert into team_countries)/.test(q)) return [];
    if (q.includes("update api_usage") && q.includes("requests_total + 1")) {
      const limit = Number(values[values.length - 1]);
      if (usage >= limit) return [];
      usage += 1;
      return [{ requests_total: usage }];
    }
    if (q.includes("select requests_total, heartbeat")) {
      return [{ requests_total: usage, heartbeat_requests: usage, detail_requests: 0 }];
    }
    if (q.includes("select requests_total")) return [{ requests_total: usage }];
    if (q.includes("insert into automation_runs")) return [{ id: 1 }];
    if (q.includes("count(*) as n from fixture_state")) return [{ n: 5 }];
    if (q.includes("select value from app_flags")) return [];
    if (q.includes("select fixture_id, snapshot")) {
      const ids = JSON.parse(String(values[0])) as number[];
      return ids.filter((id) => saved.has(id)).map((id) => ({
        fixture_id: id,
        snapshot: saved.get(id),
        is_terminal: false,
      }));
    }
    if (q.includes("select fixture_id from fixture_state")) {
      return [...saved.keys()].map((id) => ({ fixture_id: id }));
    }
    if (q.includes("select event_key, status")) {
      const keys = JSON.parse(String(values[0])) as string[];
      return keys.filter((key) => rows.has(key)).map((key) => ({
        event_key: key,
        status: rows.get(key)?.status,
      }));
    }
    if (q.startsWith("insert into posted_events")) {
      const key = String(values[0]);
      if (rows.has(key)) return [];
      rows.set(key, {
        fixtureId: Number(values[1]),
        kind: String(values[2]),
        message: String(values[3]),
        status: "claimed",
        attempts: 1,
        parentKey: null,
        updatedAt: new Date().toISOString(),
        fbPostId: null,
      });
      return [{ event_key: key }];
    }
    if (q.includes("set parent_key =")) {
      const key = findKey(values);
      if (key) rows.get(key)!.parentKey = String(values.find((v) => typeof v === "string" && v !== key));
      return [];
    }
    if (q.includes("select event_key from posted_events where parent_key")) {
      const parent = String(values[0]);
      return [...rows.entries()].filter(([, row]) => row.parentKey === parent).map(([key]) => ({ event_key: key }));
    }
    if (q.includes("update posted_events child") && q.includes("from posted_events parent")) {
      const repaired: Array<{ event_key: string }> = [];
      for (const [key, child] of rows) {
        const parent = child.parentKey ? rows.get(child.parentKey) : null;
        if (parent?.status === "posted" && child.status !== "posted") {
          child.status = "posted";
          child.fbPostId = parent.fbPostId;
          repaired.push({ event_key: key });
        }
      }
      return repaired;
    }
    if (q.includes("where status = 'claimed'") && q.includes("claim expired")) return [];
    if (q.includes("status = 'posted'") && q.includes("where event_key")) {
      if (failPostedAckOnce) {
        failPostedAckOnce = false;
        throw new Error("simulated Neon acknowledgement failure");
      }
      const key = findKey(values);
      if (key) {
        rows.get(key)!.status = "posted";
        const postId = values.find((v) => typeof v === "string" && v !== key && String(v).startsWith("p_"));
        rows.get(key)!.fbPostId = typeof postId === "string" ? postId : rows.get(key)!.fbPostId;
      }
      return [];
    }
    if (q.includes("status = 'uncertain'") && q.includes("where event_key")) {
      const key = findKey(values);
      if (key) {
        rows.get(key)!.status = "uncertain";
        rows.get(key)!.updatedAt = new Date().toISOString();
      }
      return [];
    }
    if (
      q.includes("status = 'blocked'") &&
      q.includes("where event_key") &&
      !q.includes("attempts = attempts + 1")
    ) {
      const key = findKey(values);
      if (key) rows.get(key)!.status = "blocked";
      return [];
    }
    if (q.includes("status = 'failed'") && q.includes("where event_key")) {
      const key = findKey(values);
      if (key) rows.get(key)!.status = "failed";
      return [];
    }
    if (q.includes("status = 'claimed', attempts = attempts + 1")) {
      const key = String(values[0]);
      const row = rows.get(key);
      if (!row || (row.status !== "failed" && row.status !== "blocked")) return [];
      row.status = "claimed";
      row.attempts += 1;
      return [{ event_key: key }];
    }
    if (q.includes("select event_key, fixture_id, kind, message, updated_at")) {
      return [...rows.entries()].filter(([, row]) => row.status === "uncertain" && !MEMBER_KINDS.has(row.kind)).map(([key, row]) => ({
        event_key: key,
        fixture_id: row.fixtureId,
        kind: row.kind,
        message: row.message,
        updated_at: row.updatedAt,
      }));
    }
    if (q.includes("select event_key, fixture_id, kind, message, attempts")) {
      return [...rows.entries()]
        .filter(([, row]) => (row.status === "failed" || row.status === "blocked") && !MEMBER_KINDS.has(row.kind))
        .map(([key, row]) => ({
          event_key: key,
          fixture_id: row.fixtureId,
          kind: row.kind,
          message: row.message,
          attempts: row.attempts,
        }));
    }
    if (q.startsWith("insert into fixture_state")) {
      saved.set(Number(values[0]), JSON.parse(String(values[1])));
      return [];
    }
    return [];
  };

  const neonBody = (records: Record<string, unknown>[]) => {
    const names = records.length ? Object.keys(records[0]) : [];
    const oid = (_name: string, value: unknown) =>
      value !== null && typeof value === "object" ? 3802
      : typeof value === "boolean" ? 16
      : typeof value === "number" ? 20
      : 25;
    return JSON.stringify({
      command: "SELECT",
      rowCount: records.length,
      fields: names.map((name) => ({ name, dataTypeID: oid(name, records[0]?.[name]) })),
      rows: records.map((record) => names.map((name) => {
        const value = record[name];
        return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
      })),
      rowAsArray: true,
    });
  };

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/sql")) {
      const payload = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
        query: string;
        params: unknown[];
      };
      const parts = payload.query.split(/\$\d+/);
      const template = Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
      const result = await sql(template, ...(payload.params ?? [])) as Record<string, unknown>[];
      return new Response(neonBody(result), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("graph.facebook.com") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ data: pageFeed }), { status: 200 });
    }
    if (target.includes("graph.facebook.com")) {
      const message = new URLSearchParams(String((init as { body?: unknown })?.body ?? "")).get("message") ?? "";
      if (graphMode === "auth") {
        return new Response(JSON.stringify({ error: { message: "expired", code: 190, error_subcode: 463 } }), { status: 400 });
      }
      if (graphMode === "accept-timeout") {
        const id = `p_${pageFeed.length + 1}`;
        pageFeed.push({ id, message, created_time: new Date().toISOString() });
        throw new Error("socket timeout after accept");
      }
      if (graphMode === "reject-timeout") throw new Error("socket timeout before accept");
      const id = `p_${pageFeed.length + 1}`;
      pageFeed.push({ id, message, created_time: new Date().toISOString() });
      sentPosts.push(message);
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (target.includes("/fixtures?live=all")) {
      return new Response(JSON.stringify({ errors: [], results: live.length, response: live }), { status: 200 });
    }
    if (target.includes("/fixtures?ids=") || target.includes("/fixtures?id=")) {
      detailCount += 1;
      return new Response(JSON.stringify({ errors: [], results: detail.length, response: detail }), { status: 200 });
    }
    if (target.includes("/teams?id=")) return new Response(JSON.stringify({ errors: [], response: [] }), { status: 200 });
    throw new Error(`unexpected call ${target}`);
  }) as typeof fetch;

  return {
    sentPosts, pageFeed, rows, saved,
    usage: () => usage,
    detailCount: () => detailCount,
    setLive: (value: unknown[]) => { live = value; },
    setDetail: (value: unknown[]) => { detail = value; },
    setGraphMode: (value: GraphMode) => { graphMode = value; },
    failNextPostedAck: () => { failPostedAckOnce = true; },
    ageUncertainRows: () => {
      for (const row of rows.values()) if (row.status === "uncertain") row.updatedAt = nowOld();
    },
    insertInternalFailedRow: (key: string, fixtureId: number, kind: string, message: string) => {
      rows.set(key, { fixtureId, kind, message, status: "failed", attempts: 1, parentKey: null, updatedAt: nowOld(), fbPostId: null });
    },
  };
}

export const LEAGUE = { id: 39, name: "Premier League", country: "England", flag: null };
export function fixture(id: number, short: string, elapsed: number | null, goals: [number, number], events: unknown[] = []) {
  return {
    fixture: { id, date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), status: { long: short, short, elapsed } },
    league: LEAGUE,
    teams: { home: { id: 42, name: "Arsenal" }, away: { id: 49, name: "Chelsea" } },
    goals: { home: goals[0], away: goals[1] },
    score: { halftime: {}, fulltime: {}, penalty: {} },
    events,
  };
}
export function event(type: string, detail: string, player: string | null, minute: number, team = "Arsenal", assist: string | null = null) {
  return {
    time: { elapsed: minute, extra: null },
    team: { id: team === "Arsenal" ? 42 : 49, name: team },
    player: { id: 1, name: player },
    assist: { id: 2, name: assist },
    type, detail, comments: null,
  };
}
