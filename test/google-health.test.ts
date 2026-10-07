import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createClient } from "../src/sources/google-health/client.ts";
import { buildAuthUrl, pkcePair, SCOPES, waitForCode } from "../src/sources/google-health/oauth.ts";
import {
  googleHealthProvider,
  parseDuration,
  parseExercise,
  parseHeartRate,
  parseSleep,
} from "../src/sources/google-health/provider.ts";

// Shapes follow https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints
const hrPoint = (iso: string, bpm: number) => ({
  name: `users/me/dataTypes/heart-rate/dataPoints/${iso}`,
  heartRate: { sampleTime: { physicalTime: iso, utcOffset: "18000s" }, beatsPerMinute: String(bpm) },
});

test("parses protobuf durations", () => {
  assert.equal(parseDuration("3600s"), 3_600_000);
  assert.equal(parseDuration("-18000s"), -18_000_000);
  assert.equal(parseDuration("1.5s"), 1500);
  assert.ok(Number.isNaN(parseDuration(undefined)));
});

test("parses heart-rate samples", () => {
  assert.deepEqual(parseHeartRate(hrPoint("2026-08-20T14:16:30Z", 152)), {
    t: Date.parse("2026-08-20T14:16:30Z"),
    bpm: 152,
  });
  assert.equal(parseHeartRate({ heartRate: {} }), null);
});

test("parses exercise sessions with pauses and zones", () => {
  const r = parseExercise({
    name: "users/me/dataTypes/exercise/dataPoints/abc123",
    exercise: {
      interval: {
        startTime: "2026-08-20T14:10:00Z",
        endTime: "2026-08-20T14:35:00Z",
        startUtcOffset: "18000s",
        endUtcOffset: "18000s",
      },
      exerciseType: "SQUASH",
      displayName: "Squash",
      activeDuration: "1380s",
      metricsSummary: {
        caloriesKcal: 310.5,
        steps: "2400",
        averageHeartRateBeatsPerMinute: "158",
        heartRateZoneDurations: { lightTime: "60s", moderateTime: "120s", vigorousTime: "600s", peakTime: "600s" },
      },
      exerciseEvents: [
        { eventTime: "2026-08-20T14:20:00Z", exerciseEventType: "PAUSE" },
        { eventTime: "2026-08-20T14:21:30Z", exerciseEventType: "RESUME" },
      ],
    },
  })!;
  assert.equal(r.id, "abc123");
  assert.equal(r.type, "SQUASH");
  assert.equal(r.utcOffsetMinutes, 300);
  assert.equal(r.summary.avgHr, 158);
  assert.equal(r.summary.activeMs, 1_380_000);
  assert.equal(r.summary.zonesMs!.peak, 600_000);
  assert.deepEqual(r.events.map((e) => e.type), ["PAUSE", "RESUME"]);
});

test("keys sleep by the local date you woke up", () => {
  const d = parseSleep({
    sleep: {
      interval: { startTime: "2026-08-19T18:30:00Z", endTime: "2026-08-20T01:30:00Z", endUtcOffset: "18000s" },
      summary: { minutesAsleep: "395", minutesAwake: "25" },
      metadata: { mainSleep: true },
    },
  })!;
  assert.deepEqual(d, { date: "2026-08-20", sleepMinutes: 395, sleepAwakeMinutes: 25 });
});

test("client pages through results, refreshes on 401 and retries on 429", async () => {
  const calls: string[] = [];
  let tokenRefreshes = 0;
  const responses = [
    new Response("expired", { status: 401 }),
    new Response(JSON.stringify({ dataPoints: [hrPoint("2026-08-20T14:00:00Z", 100)], nextPageToken: "p2" })),
    new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
    new Response(JSON.stringify({ dataPoints: [hrPoint("2026-08-20T14:00:01Z", 101)] })),
  ];
  const client = createClient({
    getAccessToken: async (force) => {
      if (force) tokenRefreshes++;
      return force ? "fresh" : "stale";
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(`${(init.headers as Record<string, string>).authorization} ${url}`);
      return responses.shift()!;
    }) as typeof fetch,
    sleep: async () => {},
  });
  const points = await client.listAll("heart-rate", 'heart_rate.sample_time.physical_time >= "x"', 10_000);
  assert.equal(points.length, 2);
  assert.equal(tokenRefreshes, 1);
  assert.equal(calls.length, 4);
  assert.ok(calls[1].startsWith("Bearer fresh https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints?"));
  assert.ok(calls[3].includes("pageToken=p2"));
  assert.ok(decodeURIComponent(calls[0].replaceAll("+", " ")).includes('filter=heart_rate.sample_time.physical_time >= "x"'));
});

test("provider builds documented filters", async () => {
  const seen: { type: string; filter: string; size: number }[] = [];
  const provider = googleHealthProvider({
    listAll: async (type, filter, size) => {
      seen.push({ type, filter, size });
      return type === "heart-rate" ? [hrPoint("2026-08-20T14:00:01Z", 120), hrPoint("2026-08-20T14:00:00Z", 118)] : [];
    },
  });
  const from = Date.parse("2026-08-20T14:00:00Z");
  const hr = await provider.heartRate({ from, to: from + 3_600_000 });
  assert.deepEqual(hr.map((s) => s.bpm), [118, 120], "sorted by time");
  await provider.recordings({ from, to: from + 3_600_000 });
  await provider.daily!("2026-08-20", "2026-08-21");
  assert.equal(
    seen[0].filter,
    'heart_rate.sample_time.physical_time >= "2026-08-20T14:00:00Z" AND heart_rate.sample_time.physical_time < "2026-08-20T15:00:00Z"',
  );
  assert.deepEqual(seen[1], {
    type: "exercise",
    filter: 'exercise.interval.civil_start_time >= "2026-08-19" AND exercise.interval.civil_start_time < "2026-08-21"',
    size: 25,
  });
  assert.equal(seen[2].filter, 'daily_resting_heart_rate.date >= "2026-08-20" AND daily_resting_heart_rate.date < "2026-08-22"');
  assert.equal(seen[4].type, "sleep");
});

test("sign-in redirect is caught on localhost and checks the state", async () => {
  const port = 18_787;
  const opened: string[] = [];
  const ok = waitForCode(port, "expected-state", "https://accounts.google.com/x", (u) => opened.push(u));
  await new Promise((r) => setTimeout(r, 100));
  const res = await fetch(`http://localhost:${port}/oauth/callback?code=the-code&state=expected-state`);
  assert.equal(res.status, 200);
  assert.equal(await ok, "the-code");
  assert.deepEqual(opened, ["https://accounts.google.com/x"]);

  const forged = waitForCode(port, "expected-state", "https://accounts.google.com/x", () => {});
  const rejected = assert.rejects(forged, /state mismatch/);
  await new Promise((r) => setTimeout(r, 100));
  const bad = await fetch(`http://localhost:${port}/oauth/callback?code=stolen&state=other`);
  assert.equal(bad.status, 400);
  await rejected;
});

test("PKCE challenge is the S256 hash of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  const url = new URL(buildAuthUrl("cid", "http://localhost:8787/oauth/callback", "st", challenge));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("scope"), SCOPES.join(" "));
});
