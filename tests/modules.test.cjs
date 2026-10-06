const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const core = require("../extension/core.js"),
  settings = require("../extension/settings.js"),
  media = require("../extension/media.js"),
  wbi = require("../extension/wbi.js"),
  dm = require("../extension/danmaku.js"),
  Api = require("../extension/api.js");
const row = (content, progress = 1000, extra = {}) => ({
  id: String(progress),
  progress,
  content,
  mode: 1,
  color: 0xffffff,
  fontsize: 25,
  ctime: 1,
  midHash: "sender",
  ...extra,
});
test("Download estimate uses bits per second and preserves unknown sizes", () => {
  assert.equal(
    media.estimatedBytes([{ bandwidth: 8000 }, { size: 250 }], 2),
    2250,
  );
  assert.equal(media.estimatedBytes([{ bandwidth: 0 }], 2), null);
  assert.equal(media.estimatedBytes([{ bandwidth: 8000 }], 0), null);
});
test("MD5 implementation matches RFC vectors and UTF-8", () => {
  for (const text of [
    "",
    "a",
    "abc",
    "message digest",
    "abcdefghijklmnopqrstuvwxyz",
    "你好 B站",
    "a".repeat(1000),
  ])
    assert.equal(
      wbi.md5(text),
      crypto.createHash("md5").update(text).digest("hex"),
    );
});
test("WBI sorted signature matches the documented vector", () => {
  const p = { foo: 114, bar: 514, zab: 1919810 };
  const result = wbi.sign(
    p,
    "7cd084941338484aae1ad9425b84077c",
    "4932caff0ff746eab6f01bf08b70ac45",
    1702204169,
  );
  assert.match(result, /w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4/);
  assert.throws(() => wbi.sign(p, "bad", "bad"));
  const signed = new URLSearchParams(
    wbi.sign(
      { x: "a!'()*b" },
      "7cd084941338484aae1ad9425b84077c",
      "4932caff0ff746eab6f01bf08b70ac45",
      1702204169,
    ),
  );
  assert.equal(signed.get("x"), "ab");
});
test("advanced search preserves unknown metadata and respects UID whitelist", () => {
  const rule = core.compileRules("AI", "", "all", {
    wordBoundary: true,
    synonyms: [["AI", "人工智能"]],
  });
  assert.equal(core.evaluate("chair", rule).keep, false);
  assert.equal(core.evaluate("人工智能入门", rule).keep, true);
  assert.equal(
    core.evaluateVideo({ title: "chair", uid: "123" }, rule, {
      allowedUploaders: ["123"],
      blockedUploaders: ["123"],
    }).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo({ title: "AI" }, rule, {
      minDuration: 60,
      minViews: 500,
    }).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo({ title: "AI", duration: 3 }, rule, { minDuration: 60 })
      .keep,
    false,
  );
});
test("settings migrate old enable toggle and validate imports", async () => {
  const old = await settings.load({
    get: async () => ({ biliSearchLensSettings: { enabled: false } }),
  });
  assert.equal(old.modules.search, false);
  assert.throws(() => settings.validate({ version: 99 }));
  assert.throws(
    () =>
      settings.validate({
        ...settings.defaults,
        search: { minDuration: 20, maxDuration: 10 },
      }),
    /时长/,
  );
});
test("settings drop unknown keys, clamp values, select video over UP rules", () => {
  const value = settings.validate({
    ...settings.defaults,
    unknown: "secret",
    downloads: { concurrent: 9 },
    profiles: [
      { scope: "up:123", rules: { exclusions: "up" } },
      { scope: "BV1UftJ6rE4o", rules: { exclusions: "video" } },
    ],
  });
  assert.equal(value.unknown, undefined);
  assert.equal(value.downloads.concurrent, 3);
  assert.equal(
    settings.forVideo(value, "BV1UftJ6rE4o", 123).exclusions,
    "video",
  );
});
test("URL and filenames reject external domains, schemes and path traversal", () => {
  for (const url of [
    "https://bilivideo.com.evil.test/a",
    "http://a.bilivideo.com/a",
    "https://user:pass@a.bilivideo.com/a",
    "https://a.bilivideo.com:444/a",
    "file:///x",
    "https://evil.test/x",
  ])
    assert.throws(() => media.safeUrl(url));
  assert.equal(
    media.safeUrl("//a.bilivideo.com/video.m4s"),
    "https://a.bilivideo.com/video.m4s",
  );
  assert.equal(media.videoFromUrl("junk"), null);
  assert.equal(
    media.videoFromUrl("https://www.bilibili.com/video/BV1UftJ6rE4o/?p=2").page,
    2,
  );
  const filename = media.filename(
    "../{title}/CON",
    { title: "../../x", bvid: "BV1UftJ6rE4o" },
    { page: 1, part: "test" },
    "video",
    "m4s",
  );
  assert.ok(!filename.split("/").includes(".."));
  assert.equal(media.cleanName("CON"), "_CON");
  assert.match(filename, /-video\.m4s$/);
});
test("media normalization distinguishes DASH, direct files and DRM", () => {
  const streams = media.normalizeStreams({
    timelength: 1000,
    dash: {
      video: [
        {
          id: 80,
          base_url: "https://a.bilivideo.com/v",
          codecs: "avc1",
          height: 1080,
        },
      ],
      audio: [
        {
          id: 30280,
          baseUrl: "https://a.bilivideo.com/a",
          codecs: "mp4a",
          bandwidth: 192000,
        },
      ],
    },
  });
  assert.equal(streams.video[0].extension, "m4s");
  assert.equal(streams.audio[0].extension, "m4s");
  assert.equal(streams.duration, 1);
  assert.throws(() => media.normalizeStreams({ is_drm: true }));
  assert.throws(() =>
    media.normalizeView({ bvid: "BV1UftJ6rE4o", pages: [{ cid: -1 }] }),
  );
  assert.throws(() =>
    media.normalizeStreams({
      dash: { video: [{ id: 1, baseUrl: "https://evil.test/v" }] },
    }),
  );
});
test("MCDN primaries fall back to validated backups without losing video or audio", () => {
  const track = (id, codecs) => ({
    id,
    codecs,
    baseUrl: "https://mcdn.bilivideo.cn:8082/resource.m4s",
    backupUrl: [
      "https://unsupported.test/resource",
      "https://upos.bilivideo.com/resource.m4s",
    ],
  });
  const streams = media.normalizeStreams({
    support_formats: [112, 80, 64, 32, 16].map((quality) => ({
      quality,
      new_description: `${quality} quality`,
    })),
    dash: {
      video: [32, 16].flatMap((id) =>
        ["avc1", "hev1", "av01"].map((codec) => track(id, codec)),
      ),
      audio: [30280, 30232, 30216].map((id) => track(id, "mp4a")),
    },
  });
  assert.equal(streams.video.length, 6);
  assert.equal(streams.audio.length, 3);
  assert.deepEqual(
    streams.unavailableQualities.map((f) => f.quality),
    [112, 80, 64],
  );
  assert.ok(
    [...streams.video, ...streams.audio].every(
      (t) => new URL(t.url).hostname === "upos.bilivideo.com",
    ),
  );
  const direct = media.normalizeStreams({
    quality: 80,
    support_formats: [{ quality: 80 }],
    durl: [
      {
        url: "https://mcdn.bilivideo.cn:8082/direct.mp4",
        backup_url: ["//upos.bilivideo.com/direct.mp4"],
      },
    ],
  });
  assert.equal(direct.direct[0].url, "https://upos.bilivideo.com/direct.mp4");
  assert.deepEqual(direct.unavailableQualities, []);
  const snake = media.normalizeStreams({
    dash: {
      audio: [
        {
          id: 30280,
          base_url: "https://mcdn.bilivideo.cn:8082/a",
          backup_url: ["https://upos.bilivideo.com/a"],
        },
      ],
    },
  });
  assert.equal(snake.audio[0].url, "https://upos.bilivideo.com/a");
});
test("Backup selection keeps secure primaries and refuses unsupported backup addresses", () => {
  const streams = media.normalizeStreams({
    dash: {
      video: [
        {
          id: 80,
          baseUrl: "https://cdn.bilivideo.com/primary",
          backupUrl: ["https://cdn.bilivideo.com/backup"],
        },
      ],
    },
  });
  assert.equal(streams.video[0].url, "https://cdn.bilivideo.com/primary");
  for (const url of [
    "http://cdn.bilivideo.com/v",
    "https://cdn.bilivideo.com:8082/v",
    "https://evil.test/v",
    "https://user:pass@cdn.bilivideo.com/v",
    "https://cdn.bilivideo.com/image.png",
  ])
    assert.throws(() =>
      media.normalizeStreams({
        dash: { video: [{ id: 80, baseUrl: "bad", backupUrl: [url] }] },
      }),
    );
});
test("Playurl requests signed DASH and HTTPS addresses with current account credentials", async () => {
  let received;
  const api = new Api(async (url, options) => {
    received = { url: new URL(url), options };
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          dash: {
            audio: [{ id: 30280, base_url: "https://cdn.bilivideo.com/a" }],
          },
        },
      }),
    );
  });
  api.signature = async (params) =>
    new URLSearchParams({ ...params, w_rid: "test" }).toString();
  await api.streams("BV1UftJ6rE4o", 1234);
  assert.equal(received.url.pathname, "/x/player/wbi/playurl");
  for (const [key, value] of Object.entries({
    fnval: "4048",
    force_host: "2",
    platform: "pc",
    otype: "json",
    w_rid: "test",
  }))
    assert.equal(received.url.searchParams.get(key), value);
  assert.equal(received.options.credentials, "include");
  assert.ok(received.options.signal instanceof AbortSignal);
});
test("subtitles validate time ordering and preserve precision", () => {
  const source = { body: [{ from: 1.234, to: 4.567, content: "<文字> -->" }] };
  assert.match(media.subtitle(source), /00:00:01,234 --> 00:00:04,567/);
  assert.match(media.subtitle(source, "vtt"), /^WEBVTT/);
  assert.equal(JSON.parse(media.subtitle(source, "json")).body.length, 1);
  assert.throws(() =>
    media.subtitle({ body: [{ from: 4, to: 1, content: "a" }] }),
  );
});
function vi(n) {
  let v = BigInt(n),
    out = [];
  do {
    let b = Number(v & 127n);
    v >>= 7n;
    if (v) b |= 128;
    out.push(b);
  } while (v);
  return out;
}
function str(field, text) {
  const bytes = Buffer.from(text);
  return [...vi(field * 8 + 2), ...vi(bytes.length), ...bytes];
}
test("protobuf preserves 64-bit IDs, supports unknown fields and rejects truncation", () => {
  const item = [
    8,
    ...vi("9007199254740993123"),
    16,
    ...vi(1234),
    24,
    1,
    40,
    ...vi(0xffffff),
    ...str(7, "<测试>"),
    ...str(15, "unknown"),
  ];
  const decoded = dm.decode(Uint8Array.from([10, ...vi(item.length), ...item]));
  assert.equal(decoded[0].id, "9007199254740993123");
  assert.equal(decoded[0].content, "<测试>");
  assert.equal(decoded[0].progress, 1234);
  assert.throws(() => dm.decode(Uint8Array.from([10, 9, 8])));
});
test("danmaku whitelist, keyword, regex, type and burst precedence", () => {
  const source = [
    row("白名单广告", 1000),
    row("广告", 2000),
    row("regex123", 3000),
    row("top", 4000, { mode: 5 }),
    row("repeat", 5000),
    row("repeat", 6000),
    row("repeat", 7000),
  ];
  const result = dm.filter(source, {
    exclusions: "广告",
    whitelist: "白名单",
    regex: ["regex\\d+"],
    blockedModes: [5],
    duplicateLimit: 2,
    duplicateWindow: 8,
  });
  assert.equal(result.kept.length, 3);
  assert.equal(result.rejected.length, 4);
  assert.equal(result.kept[0].content, "白名单广告");
  assert.throws(() => dm.filter(source, { regex: ["["] }));
  assert.match(result.rejected.at(-1).reason, /重复/);
});
test("JSON/XML/ASS preserve advanced data without executing instructions", () => {
  const source = [
    row('<&>"', 1234),
    row("{\\p1}evil", 3000, { id: "2", mode: 7 }),
    row("literal {\\N}", 5000, { id: "3" }),
  ];
  const xml = dm.xml(source, 12);
  assert.match(xml, /&lt;&amp;&gt;&quot;/);
  const ass = dm.ass(source);
  assert.equal(ass.unsupported, 1);
  assert.match(ass.text, /0:00:01\.23/);
  assert.ok(!ass.text.includes("{\\p1}evil"));
  assert.ok(ass.text.includes("｛＼N｝"));
  assert.equal(dm.dedupe([...source, source[0]]).length, 3);
});
test("ASS crowded lanes report omitted rows instead of corrupt timings", () => {
  const data = Array.from({ length: 100 }, (_, i) =>
    row(String(i), 1000, { id: String(i) }),
  );
  const ass = dm.ass(data, { fontSize: 72, area: 0.1 });
  assert.ok(ass.dropped > 0);
  assert.equal(ass.dropped + ass.text.split("Dialogue:").length - 1, 100);
});
test("API refuses unknown paths and surfaces authorization and wind-control errors", async () => {
  const api = new Api(async () => ({
    ok: true,
    json: async () => ({ code: -101 }),
  }));
  await assert.rejects(api.request("/evil"), /路径/);
  await assert.rejects(api.request("/x/web-interface/view"), /登录/);
  const other = new Api(async () => ({ ok: false, status: 412 }));
  await assert.rejects(other.request("/x/web-interface/view"), /风控/);
});
test("cancelled API operations clean controllers and do not fetch after signature", async () => {
  let calls = 0;
  const api = new Api(async () => {
    calls++;
    return { ok: true, json: async () => ({ code: 0, data: {} }) };
  });
  api.signature = async () => {
    api.cancel("cancel");
    return "a=1";
  };
  await assert.rejects(
    api.request("/x/player/wbi/v2", {}, { signed: true, token: "cancel" }),
    /取消/,
  );
  assert.equal(calls, 0);
  assert.equal(api.controllers.size, 0);
  api.signature = async () => {
    throw new Error("bad keys");
  };
  await assert.rejects(
    api.request("/x/player/wbi/v2", {}, { signed: true, token: "failed" }),
    /bad keys/,
  );
  assert.equal(api.controllers.size, 0);
});
test("API retries transient HTTP failures once, but never retries wind control", async () => {
  let calls = 0;
  const api = new Api(async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 503 }
      : {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { value: 1 } }),
        };
  });
  assert.equal((await api.request("/x/web-interface/view")).value, 1);
  assert.equal(calls, 2);
  let blocked = 0;
  const risk = new Api(async () => {
    blocked++;
    return { ok: false, status: 412 };
  });
  await assert.rejects(risk.request("/x/web-interface/view"), /风控/);
  assert.equal(blocked, 1);
});
test("abort propagates through a pending WBI navigation request", async () => {
  let started;
  const pending = new Promise((resolve) => (started = resolve));
  let calls = 0;
  const api = new Api(async (url, { signal }) => {
    calls++;
    started();
    return new Promise((resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  const controller = new AbortController();
  const operation = api.streams("BV1UftJ6rE4o", 1234, 80, {
    signal: controller.signal,
  });
  await pending;
  controller.abort();
  await assert.rejects(operation, /取消/);
  assert.equal(calls, 1);
});
test("ASS text importer keeps timing and skips vector drawings", () => {
  const parsed = dm.parseAss(
    "Dialogue: 0,0:00:01.25,0:00:03.00,Default,,0,0,0,,hello\\Nworld\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 1 1",
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].progress, 1250);
  assert.equal(parsed[0].content, "hello\nworld");
});
