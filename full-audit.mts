import assert from "node:assert/strict";
import { makeHarness, fixture, event } from "./audit-harness.mts";

process.env.DATABASE_URL = "postgresql://u:p@mock.neon.tech/db?sslmode=require";
process.env.FOOTBALL_API_KEY = "k";
process.env.FOOTBALL_API_BASE_URL = "https://v3.football.api-sports.io";
process.env.FACEBOOK_PAGE_ID = "1";
process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "t";
process.env.FOOTBALL_API_DETAIL_MAX_BATCHES = "1";

const { runAutomation } = await import("/app/src/lib/football/pipeline.ts");
const { diffFixture, buildSnapshot } = await import("/app/src/lib/football/lifecycle.ts");
const { composeMessage, hasPublishableContent } = await import("/app/src/lib/football/messages.ts");
const { fetchLiveFixtures } = await import("/app/src/lib/football/api.ts");
const { validateMessage } = await import("/app/src/lib/football/validate.ts");
const { HARD_DAILY_LIMIT, dailyBudget } = await import("/app/src/lib/football/config.ts");

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n   ${(e as Error).message}`); }
}
const MIN = "\u2019";

/* ---------------- Event occurrence/dedup ---------------- */

await test("D1: two players with the same surname/card/minute are BOTH preserved", async () => {
  const h = makeHarness();
  h.setLive([fixture(1, "2H", 50, [0, 0])]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.setLive([fixture(1, "2H", 52, [0, 0], [
    event("Card", "Yellow Card", "A. Smith", 51),
    event("Card", "Yellow Card", "B. Smith", 51),
  ])]);
  await runAutomation();
  const cardPost = h.sentPosts.find((p) => p.includes("Yellow Card"));
  assert.ok(cardPost, JSON.stringify(h.sentPosts));
  assert.ok(cardPost!.includes(`🟨 Yellow Card: A. Smith (51${MIN}) [Arsenal]`), cardPost!);
  assert.ok(cardPost!.includes(`🟨 Yellow Card: B. Smith (51${MIN}) [Arsenal]`), cardPost!);
});

await test("D2: a third identical-base occurrence later posts once, first two do not repeat", async () => {
  const h = makeHarness();
  const firstTwo = [
    event("Card", "Yellow Card", "A. Smith", 51),
    event("Card", "Yellow Card", "B. Smith", 51),
  ];
  h.setLive([fixture(2, "2H", 52, [0, 0], firstTwo)]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.setLive([fixture(2, "2H", 55, [0, 0], [
    ...firstTwo,
    event("Card", "Yellow Card", "C. Smith", 51),
  ])]);
  await runAutomation();
  const cards = h.sentPosts.filter((p) => p.includes("Yellow Card"));
  assert.equal(cards.length, 1, JSON.stringify(h.sentPosts));
  assert.ok(cards[0].includes("C. Smith"), cards[0]);
  assert.ok(!cards[0].includes("A. Smith") && !cards[0].includes("B. Smith"), cards[0]);
});

await test("D3: API refinements do not repost the same event", async () => {
  const refinements: Array<[unknown, unknown]> = [
    [event("Goal", "Normal Goal", "Saka", 48), event("Goal", "Normal Goal", "Saka", 48, "Arsenal", "Odegaard")],
    [event("Goal", "Normal Goal", "K. Havertz", 49), event("Goal", "Normal Goal", "Kai Havertz", 49)],
    [event("Var", "Goal cancelled", null, 60), event("Var", "Goal Disallowed - offside", null, 60)],
    [event("Card", "Yellow Card", "Caicedo", 61), event("Card", "Yellow Card (Foul)", "Caicedo", 61)],
  ];
  for (const [before, after] of refinements) {
    const h = makeHarness();
    h.setLive([fixture(3, "2H", 40, [0, 0])]);
    await runAutomation();
    h.setLive([fixture(3, "2H", 62, [1, 0], [before])]);
    await runAutomation();
    h.sentPosts.length = 0;
    h.setLive([fixture(3, "2H", 65, [1, 0], [after])]);
    await runAutomation();
    assert.equal(h.sentPosts.length, 0, JSON.stringify(h.sentPosts));
  }
});

await test("D4: concurrent runs publish a logical event once", async () => {
  const h = makeHarness();
  h.setLive([fixture(4, "2H", 40, [0, 0])]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.setLive([fixture(4, "2H", 50, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await Promise.all([runAutomation(), runAutomation()]);
  assert.equal(h.sentPosts.filter((p) => p.includes("Saka")).length, 1, JSON.stringify(h.sentPosts));
});

/* ---------------- Facebook uncertain outcomes ---------------- */

await test("FB1: accepted-then-timeout reconciles as posted without a second POST", async () => {
  const h = makeHarness();
  h.setLive([fixture(10, "2H", 40, [0, 0])]);
  await runAutomation();
  h.setGraphMode("accept-timeout");
  h.setLive([fixture(10, "2H", 50, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await runAutomation();
  assert.equal(h.pageFeed.length, 1, "Facebook should contain the accepted post");
  const resolvedOrUncertain = [...h.rows.values()].filter(
    (row) => row.status === "uncertain" || row.status === "posted",
  );
  assert.ok(resolvedOrUncertain.length >= 1, "outcome was neither queued nor reconciled");

  h.setGraphMode("ok");
  h.setLive([fixture(10, "2H", 55, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await runAutomation();
  assert.equal(h.pageFeed.length, 1, "reconciliation sent a duplicate POST");
  const parentRows = [...h.rows.values()].filter((row) => row.kind === "live_update");
  assert.ok(parentRows.some((row) => row.status === "posted"), "parent not reconciled posted");
});

await test("FB2: timeout-before-accept is retried only after feed confirms absence", async () => {
  const h = makeHarness();
  h.setLive([fixture(11, "2H", 40, [0, 0])]);
  await runAutomation();
  h.setGraphMode("reject-timeout");
  h.setLive([fixture(11, "2H", 50, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await runAutomation();
  assert.equal(h.pageFeed.length, 0);
  assert.ok([...h.rows.values()].some((row) => row.status === "uncertain"));

  h.ageUncertainRows();
  h.setGraphMode("ok");
  h.setLive([fixture(11, "2H", 55, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await runAutomation();
  if (h.pageFeed.length !== 1) {
    console.log("FB2 rows", JSON.stringify([...h.rows.entries()]));
  }
  assert.equal(h.pageFeed.length, 1, "confirmed-absent post was not retried once");
  assert.equal(h.sentPosts.length, 1);
});

await test("FB3: Graph success + Neon ack failure never causes a duplicate POST", async () => {
  const h = makeHarness();
  h.setLive([fixture(12, "2H", 40, [0, 0])]);
  await runAutomation();
  h.failNextPostedAck();
  h.setLive([fixture(12, "2H", 50, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await runAutomation();
  assert.equal(h.pageFeed.length, 1, "initial Graph post missing");

  h.setLive([fixture(12, "2H", 55, [1, 0], [event("Goal", "Normal Goal", "Saka", 48)])]);
  await runAutomation();
  assert.equal(h.pageFeed.length, 1, "Neon failure caused a duplicate Facebook post");
});

await test("FB4: internal member rows never enter the standalone retry queue", async () => {
  const h = makeHarness();
  h.setLive([fixture(13, "2H", 40, [0, 0])]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.insertInternalFailedRow(
    "fx13:ev:internal",
    13,
    "goal",
    `⚽️ Goal: Not A Complete Post (40${MIN}) [Arsenal]`,
  );
  await runAutomation();
  assert.equal(h.sentPosts.length, 0, "internal event line was sent as a Facebook post");
});

/* ---------------- Full-time and state correctness ---------------- */

await test("FT1: late goal uses normal format; FT is separate and confirmed", async () => {
  const h = makeHarness();
  h.setLive([fixture(20, "2H", 88, [1, 1])]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.setLive([]);
  h.setDetail([fixture(20, "FT", 90, [2, 1], [event("Goal", "Normal Goal", "Saka", 90)])]);
  await runAutomation();
  assert.ok(h.sentPosts.includes(`🚩 Live: Arsenal 2-1 Chelsea\n\n⚽️ Goal: Saka (90${MIN}) [Arsenal]`), JSON.stringify(h.sentPosts));
  assert.ok(h.sentPosts.includes("🚩 FT: Arsenal 2-1 Chelsea"), JSON.stringify(h.sentPosts));
  assert.equal(h.sentPosts.filter((p) => p.startsWith("🚩 FT:")).length, 1);
});

await test("FT2: no confirmed detail means no guessed result", async () => {
  const h = makeHarness();
  h.setLive([fixture(21, "2H", 88, [1, 1])]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.setLive([]);
  h.setDetail([]);
  await runAutomation();
  assert.equal(h.sentPosts.filter((p) => p.startsWith("🚩 FT:")).length, 0);
});

await test("FT3: missing final score is not publishable", () => {
  const previous = buildSnapshot(fixture(22, "2H", 88, [1, 0]));
  const broken = fixture(22, "FT", 90, [1, 0]) as Record<string, unknown>;
  broken.goals = { home: null, away: null };
  const output = diffFixture(previous, broken as never, { bootstrap: false });
  const final = output.find((item) => item.kind === "fulltime");
  assert.ok(final);
  assert.equal(hasPublishableContent(final!), false);
});

await test("FT4: awarded/walkover use source winner; absent source never guessed", () => {
  const previous = buildSnapshot(fixture(23, "2H", 60, [0, 0]));
  const awarded = fixture(23, "AWD", 60, [3, 0]) as Record<string, any>;
  awarded.teams.home.winner = true;
  awarded.teams.away.winner = false;
  const candidate = diffFixture(previous, awarded as never, { bootstrap: false })
    .find((item) => item.kind === "awarded");
  assert.equal(composeMessage(candidate!), "🚩 Awarded: Arsenal 3-0 Chelsea [Arsenal]");

  const walkover = fixture(24, "WO", 0, [0, 0]) as Record<string, any>;
  walkover.teams.home.winner = null;
  walkover.teams.away.winner = null;
  const wo = diffFixture(buildSnapshot(fixture(24, "NS", 0, [0, 0])), walkover as never, { bootstrap: false })
    .find((item) => item.kind === "walkover");
  assert.equal(composeMessage(wo!), "🚩 Walkover: Arsenal vs Chelsea");
});

/* ---------------- Safety and integration ---------------- */

await test("S1: allowlist blocks an unapproved competition through final status", async () => {
  const h = makeHarness();
  const bad = { id: 99999, name: "Premier League 2", country: "England", flag: null };
  const first = fixture(30, "2H", 60, [1, 0]) as Record<string, any>;
  first.league = bad;
  h.setLive([first]);
  await runAutomation();
  h.sentPosts.length = 0;
  const final = fixture(30, "FT", 90, [1, 0]) as Record<string, any>;
  final.league = bad;
  h.setLive([]);
  h.setDetail([final]);
  await runAutomation();
  assert.equal(h.sentPosts.length, 0);
});

await test("S2: malformed API body is rejected safely", async () => {
  const h = makeHarness();
  globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;
  await assert.rejects(() => fetchLiveFixtures({} as never));
  assert.equal(h.sentPosts.length, 0);
});

await test("S3: every post has exact spacing and no banned content", async () => {
  const h = makeHarness();
  h.setLive([fixture(31, "2H", 60, [0, 0])]);
  await runAutomation();
  h.sentPosts.length = 0;
  h.setLive([fixture(31, "FT", 90, [1, 0], [
    event("Goal", "Normal Goal", "Saka", 70, "Arsenal", "Odegaard"),
    event("Card", "Red Card", "James", 72, "Chelsea"),
    event("subst", "Substitution 1", "Off", 74, "Arsenal", "On"),
    event("Var", "Card upgraded", "C", 76, "Chelsea"),
    event("Corner", "Corner Kick", null, 78),
  ])]);
  await runAutomation();
  for (const post of h.sentPosts) {
    const validation = validateMessage(post);
    assert.ok(validation.ok, `${validation.reason}\n${post}`);
    assert.ok(!post.includes("#") && !/corner|Late Winner|predict|reaction/i.test(post), post);
    assert.ok(!/undefined|null|NaN/.test(post), post);
  }
});

await test("S4: lineup can load without consuming the protected finish-recovery slot", async () => {
  const h = makeHarness();
  const live = fixture(33, "1H", 8, [0, 0]);
  const withLineup = {
    ...fixture(33, "1H", 8, [0, 0]),
    lineups: [
      {
        team: { id: 42, name: "Arsenal" },
        formation: "4-3-3",
        startXI: [
          { player: { id: 1, name: "Raya", number: 1, pos: "G", grid: "1:1" } },
          { player: { id: 2, name: "White", number: 2, pos: "D", grid: "2:1" } },
        ],
      },
      {
        team: { id: 49, name: "Chelsea" },
        formation: "4-2-3-1",
        startXI: [
          { player: { id: 3, name: "Sanchez", number: 1, pos: "G", grid: "1:1" } },
          { player: { id: 4, name: "James", number: 2, pos: "D", grid: "2:1" } },
        ],
      },
    ],
  };
  h.setLive([live]);
  h.setDetail([withLineup]);
  await runAutomation();
  assert.ok(h.sentPosts.some((p) => p.includes("Arsenal XI: Raya; White")),
    "lineup request was starved");

  h.sentPosts.length = 0;
  h.setLive([]);
  h.setDetail([fixture(33, "FT", 90, [1, 0])]);
  await runAutomation();
  assert.ok(h.sentPosts.includes("🚩 FT: Arsenal 1-0 Chelsea"),
    "lineup consumed the finish-recovery allowance");
  assert.ok(h.usage() <= 4, `unexpected API usage: ${h.usage()}`);
});

await test("S5: quota and config are unchanged", () => {
  assert.equal(HARD_DAILY_LIMIT, 100);
  assert.equal(dailyBudget(), 100);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
