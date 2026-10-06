/* Explicit network QA in a disposable, signed-out browser profile. */
const fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts"),
  directory = fs.mkdtempSync(path.join(artifacts, "live-extension-")),
  profile = fs.mkdtempSync(path.join(artifacts, "live-profile-"));
fs.cpSync(path.join(root, "extension"), directory, { recursive: true });
const manifest = JSON.parse(
  fs.readFileSync(path.join(directory, "manifest.json")),
);
manifest.permissions.push("declarativeNetRequestWithHostAccess");
manifest.host_permissions = manifest.optional_host_permissions;
manifest.optional_permissions = manifest.optional_permissions.filter(
  (p) => p !== "declarativeNetRequestWithHostAccess",
);
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify(manifest),
);
(async () => {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--load-extension=${directory}`,
      `--disable-extensions-except=${directory}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const report = await worker.evaluate(async () => {
      await prepareHeaders();
      const result = {
        date: new Date().toISOString(),
        session: "isolated browser/no account",
        checks: {},
      };
      const view = await api.view("BV1UftJ6rE4o"),
        part = view.pages[0];
      result.checks.metadata = { ok: true, pages: view.pages.length };
      for (const [name, fn] of [
        [
          "streams",
          async () => {
            const streams = await api.streams(view.bvid, part.cid),
              track = [...streams.video, ...streams.direct][0];
            const response = await fetch(track.url, {
              headers: { Range: "bytes=0-4095" },
              signal: AbortSignal.timeout(20000),
            });
            const info = {
              ok: response.ok,
              status: response.status,
              video: streams.video.length,
              audio: streams.audio.length,
            };
            await response.body?.cancel();
            return info;
          },
        ],
        [
          "danmaku",
          async () => ({
            ok: true,
            rows: (await api.segment(part.cid, 1, "probe")).length,
          }),
        ],
        [
          "subtitles",
          async () => ({
            ok: true,
            tracks:
              (await api.player(view.bvid, part.cid)).subtitle?.subtitles
                ?.length || 0,
          }),
        ],
      ]) {
        try {
          result.checks[name] = await fn();
        } catch (error) {
          result.checks[name] = {
            ok: false,
            error: String(error.message).replace(/https?:\/\/\S+/g, "[hidden]"),
          };
        }
      }
      return result;
    });
    fs.writeFileSync(
      path.join(artifacts, "live-extension-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(String(error.message).replace(/https?:\/\/\S+/g, "[hidden]"));
  process.exitCode = 1;
});
