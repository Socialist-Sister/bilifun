/* Explicit public interface probe; no cookies, account data, or signed URLs saved. */
const fs = require("node:fs"),
  path = require("node:path");
require("../extension/media.js");
require("../extension/wbi.js");
require("../extension/danmaku.js");
const Api = require("../extension/api.js");
const api = new Api((url, options) =>
  fetch(url, {
    ...options,
    credentials: "omit",
    headers: { Referer: "https://www.bilibili.com/" },
  }),
);
(async () => {
  const report = {
    date: new Date().toISOString(),
    session: "public/no cookies",
    sample: "BV1UftJ6rE4o",
    checks: {},
  };
  const view = await api.view(report.sample),
    page = view.pages[0];
  report.checks.metadata = {
    ok: true,
    pages: view.pages.length,
    cid: page.cid,
    duration: page.duration,
  };
  for (const [name, operation] of [
    [
      "streams",
      async () => {
        const tracks = await api.streams(view.bvid, page.cid);
        const track = [...tracks.video, ...tracks.direct][0];
        const response = await fetch(track.url, {
          headers: {
            Referer: "https://www.bilibili.com/",
            Range: "bytes=0-4095",
          },
          signal: AbortSignal.timeout(20000),
        });
        const info = {
          ok: response.ok,
          videoTracks: tracks.video.length,
          audioTracks: tracks.audio.length,
          directFiles: tracks.direct.length,
          rangeStatus: response.status,
          contentType: response.headers.get("content-type"),
        };
        await response.body?.cancel();
        return info;
      },
    ],
    [
      "danmaku",
      async () => {
        const rows = await api.segment(page.cid, 1, "probe");
        return {
          ok: true,
          segment: 1,
          rows: rows.length,
          safeIds: rows.every((row) => typeof row.id === "string"),
          modes: [...new Set(rows.map((row) => row.mode))],
        };
      },
    ],
    [
      "subtitles",
      async () => {
        const player = await api.player(view.bvid, page.cid);
        return { ok: true, tracks: player.subtitle?.subtitles?.length || 0 };
      },
    ],
    [
      "search",
      async () => {
        const rows = await api.search("机械键盘", 1, "totalrank");
        return { ok: true, results: rows.length };
      },
    ],
  ]) {
    try {
      report.checks[name] = await operation();
    } catch (error) {
      report.checks[name] = {
        ok: false,
        error: String(error.message).replace(/https?:\/\/\S+/g, "[hidden]"),
      };
    }
  }
  const target = path.resolve(
    __dirname,
    "../artifacts/live-interface-report.json",
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(String(error.message).replace(/https?:\/\/\S+/g, "[hidden]"));
  process.exitCode = 1;
});
