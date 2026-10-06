/* Actual MV3 offscreen + OPFS + Downloads, isolated profile, synthetic media.
 * Bilibili API fixture is injected only into the disposable extension worker;
 * CDN requests still use fetch + actual Range headers against a local HTTP server.
 * Small delays in the disposable copy exercise module readiness and slow cleanup. */
const http = require("node:http");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts"),
  directory = fs.mkdtempSync(path.join(artifacts, "browser-remux-")),
  extension = path.join(directory, "extension"),
  downloads = path.join(directory, "downloads");
fs.cpSync(path.join(root, "extension"), extension, { recursive: true });
fs.mkdirSync(downloads);
const manifest = JSON.parse(
  fs.readFileSync(path.join(extension, "manifest.json")),
);
manifest.permissions.push("downloads", "declarativeNetRequestWithHostAccess");
manifest.optional_permissions = manifest.optional_permissions.filter(
  (x) => !manifest.permissions.includes(x),
);
manifest.host_permissions = [
  ...manifest.optional_host_permissions,
  "http://127.0.0.1/*",
];
delete manifest.optional_host_permissions;
fs.writeFileSync(
  path.join(extension, "manifest.json"),
  JSON.stringify(manifest),
);
// Only the disposable extension permits our loopback media fixture. Keep the
// production initiator/type restrictions: the server rejects missing Referer.
const backgroundPath = path.join(extension, "background.js"),
  background = fs.readFileSync(backgroundPath, "utf8");
assert.ok(
  background.includes('requestDomains: [\n            "api.bilibili.com"') ||
    background.includes('requestDomains: [\r\n            "api.bilibili.com"'),
);
fs.writeFileSync(
  backgroundPath,
  background.replace(
    /requestDomains: \[\r?\n/,
    'requestDomains: [\n            "127.0.0.1",\n',
  ),
);
const remuxPath = path.join(extension, "remux.js");
fs.writeFileSync(
  remuxPath,
  fs
    .readFileSync(remuxPath, "utf8")
    .replace("globalThis.LensMedia.safeUrl(track.url)", "track.url")
    .replace(
      "const active = new Map();",
      "await new Promise(resolve => setTimeout(resolve, 200));\nconst active = new Map();",
    )
    .replace(
      "clearInterval(heartbeat);",
      "clearInterval(heartbeat);\nawait new Promise(resolve => setTimeout(resolve, 300));",
    ),
);
if (process.env.TEST_CONVERT === "1") {
  const convertWorker = path.join(extension, "convert-worker.js");
  fs.writeFileSync(
    convertWorker,
    fs
      .readFileSync(convertWorker, "utf8")
      .replace(
        "const code = core.exec(...args);",
        'self.postMessage({progress:{phase:"FFmpeg 编码运行",processedMs:0}});\nconst code = core.exec(...args);',
      ),
  );
}
const bvid = "BV1test000001",
  ranges = [],
  checks = [];
const fixtures = path.join(artifacts, "browser-remux-fixtures"),
  video = fs.readFileSync(path.join(fixtures, "video.m4s")),
  audio = fs.readFileSync(path.join(fixtures, "audio.m4s"));
let mode = "ok",
  releaseSlow;
async function check(name, action) {
  await action();
  checks.push(name);
  console.log("PASS " + name);
}
(async () => {
  const server = http.createServer(async (req, res) => {
    const range = req.headers.range,
      bytes = req.url.includes("audio") ? audio : video;
    ranges.push({ url: req.url, range, referer: req.headers.referer });
    if (req.headers.referer !== "https://www.bilibili.com/") {
      res.writeHead(403, { "content-type": "text/html" });
      return res.end("missing media source permission");
    }
    if (mode === "fail") {
      res.writeHead(403);
      return res.end("denied");
    }
    if (mode === "slow")
      await new Promise((resolve) => {
        releaseSlow = resolve;
        res.on("close", resolve);
      });
    if (res.destroyed) return;
    const match = /bytes=(\d+)-(\d+)/.exec(range || "");
    if (!match) {
      res.writeHead(400);
      return res.end();
    }
    const start = Number(match[1]),
      end = Math.min(Number(match[2]), bytes.length - 1);
    res.writeHead(206, {
      "content-type": "video/mp4",
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
      "content-length": String(end - start + 1),
    });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(
    path.join(directory, "profile"),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      acceptDownloads: true,
      downloadsPath: downloads,
    },
  );
  let page;
  try {
    let worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const base = worker.url().replace("background.js", "");
    async function fixture(w = worker) {
      await w.evaluate(
        ({ bvid, origin }) => {
          api.view = async () => ({
            bvid,
            title: "浏览器重封装测试",
            owner: { name: "QA" },
            pages: [1234, 2345].map((cid, index) => ({
              cid,
              page: index + 1,
              part: "B帧与偏移" + index,
              duration: 13,
            })),
          });
          api.streams = async () => ({
            video: [
              {
                key: "video:80:avc1",
                kind: "video",
                url: origin + "/video.m4s",
                label: "AVC",
                bandwidth: 2000000,
              },
            ],
            audio: [
              {
                key: "audio:30280:mp4a",
                kind: "audio",
                url: origin + "/audio.m4s",
                label: "AAC",
                bandwidth: 128000,
              },
            ],
            direct: [],
            duration: 13,
          });
        },
        { bvid, origin },
      );
    }
    await fixture();
    page = await context.newPage();
    await page.goto(base + "tools.html?id=" + bvid);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloads,
      eventsEnabled: true,
    });
    async function request(op, args = {}) {
      const reply = await page.evaluate(
        ({ op, args }) => chrome.runtime.sendMessage({ op, ...args }),
        { op, args },
      );
      assert.equal(reply?.ok, true, reply?.error);
      return reply.result;
    }
    async function enqueue(cid = 1234) {
      return request("enqueueVideo", {
        bvid,
        cid,
        videoKey: "video:80:avc1",
        audioKey: "audio:30280:mp4a",
        container: "mp4",
      });
    }
    async function waitJob(id, state = "completed") {
      for (let i = 0; i < 300; i++) {
        const jobs = await page.evaluate(
            async () =>
              (await chrome.storage.local.get("lensMediaJobs")).lensMediaJobs ||
              [],
          ),
          job = jobs.find((j) => j.id === id);
        if (job?.state === state) return job;
        if (job?.state === "failed" && state !== "failed")
          throw new Error(job.error);
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Timeout " + JSON.stringify(await request("mediaJobs")));
    }
    async function waitIdle() {
      for (let i = 0; i < 150; i++) {
        const contexts = await page.evaluate(() =>
          chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }),
        );
        if (!contexts.length) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Offscreen was not released");
    }
    await check(
      "Default MP4 works without nativeMessaging, closes tools page, creates disk-backed two-track MP4",
      async () => {
        assert.equal(
          await page.evaluate(() =>
            chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
          ),
          false,
        );
        mode = "slow";
        await page.locator("#load").click();
        await page.waitForFunction(
          () => document.querySelector("#page-select").value === "1234",
        );
        await page.locator("#get-streams").click();
        await page.waitForFunction(
          () =>
            document.querySelector("#video-track").value === "video:80:avc1",
        );
        await page.locator("#download-complete").click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-tab="queue"]')
              .getAttribute("aria-selected") === "true",
        );
        const [job] = await request("mediaJobs");
        assert.ok(job && job.engine === "browser");
        for (let i = 0; i < 100 && !releaseSlow; i++)
          await new Promise((r) => setTimeout(r, 50));
        assert.ok(
          releaseSlow,
          "offscreen fetch reached CDN fixture: " +
            JSON.stringify(await request("mediaJobs")),
        );
        await page.close();
        page = await context.newPage();
        await page.goto(base + "tools.html");
        const newSession = await context.newCDPSession(page);
        await newSession.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: downloads,
          eventsEnabled: true,
        });
        mode = "ok";
        releaseSlow();
        const done = await waitJob(job.id);
        assert.equal(done.engine, "browser");
        assert.ok(fs.statSync(done.outputFilename).size > video.length);
        const ffmpeg = execFileSync(
          process.env.TEST_PYTHON_EXECUTABLE,
          [
            "-c",
            "import sys;sys.path.insert(0,'artifacts/test-deps');import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())",
          ],
          { cwd: root },
        )
          .toString()
          .trim();
        execFileSync(ffmpeg, [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          done.outputFilename,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0",
          "-f",
          "null",
          "-",
        ]);
        assert.ok(ranges.filter((r) => r.url.includes("video")).length > 1);
        for (const r of ranges) {
          const [, a, b] = /bytes=(\d+)-(\d+)/.exec(r.range);
          assert.ok(Number(b) - Number(a) + 1 <= 2 * 1024 * 1024);
        }
        assert.equal((await request("tasks")).length, 0);
        await waitIdle();
        const files = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory(),
            dir = await root.getDirectoryHandle("lens-remux-v1");
          const names = [];
          for await (const name of dir.keys()) names.push(name);
          return names;
        });
        assert.deepEqual(files, []);
      },
    );
    await check(
      "Batch UI saves two distinct audible MP4s through Referer-protected media requests, without raw downloads or helper",
      async () => {
        await page.goto(base + "tools.html?id=" + bvid);
        await page.locator("#load").click();
        await page.waitForFunction(
          () => document.querySelector("#page-select").value === "1234",
        );
        await page.locator("#get-streams").click();
        await page.waitForFunction(
          () =>
            document.querySelector("#audio-track").value === "audio:30280:mp4a",
        );
        await page.locator("#media-advanced > summary").click();
        await page.getByText("批量下载多个分 P", { exact: true }).click();
        await page.locator("#batch-pages input").first().check();
        await page.locator("#batch-pages input").last().check();
        const before = new Set(
            (await request("mediaJobs")).map((job) => job.id),
          ),
          rangeStart = ranges.length;
        await page.locator("#batch-download").click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-tab="queue"]')
              .getAttribute("aria-selected") === "true",
        );
        const added = (await request("mediaJobs")).filter(
          (job) => !before.has(job.id),
        );
        assert.equal(added.length, 2);
        assert.deepEqual(added.map((job) => job.cid).sort(), [1234, 2345]);
        assert.equal((await request("tasks")).length, 0);
        const ffmpeg = execFileSync(
          process.env.TEST_PYTHON_EXECUTABLE,
          [
            "-c",
            "import sys;sys.path.insert(0,'artifacts/test-deps');import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())",
          ],
          { cwd: root },
        )
          .toString()
          .trim();
        const outputs = [];
        for (const job of added) {
          const done = await waitJob(job.id);
          assert.equal(done.engine, "browser");
          assert.match(done.outputFilename, /\.mp4$/);
          assert.ok(fs.statSync(done.outputFilename).size > video.length);
          execFileSync(ffmpeg, [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            done.outputFilename,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-f",
            "null",
            "-",
          ]);
          outputs.push(done.outputFilename);
        }
        assert.equal(new Set(outputs).size, 2);
        assert.ok(ranges.length > rangeStart);
        assert.ok(
          ranges
            .slice(rangeStart)
            .every((r) => r.referer === "https://www.bilibili.com/"),
        );
        await waitIdle();
      },
    );
    await check(
      "Batch missing second-part audio reports its part and preserves the first queued MP4",
      async () => {
        await worker.evaluate(() => {
          const original = api.streams;
          api.streams = async (bvid, cid, ...args) => {
            const result = await original(bvid, cid, ...args);
            return cid === 2345 ? { ...result, audio: [] } : result;
          };
          resourceCache.clear();
        });
        await page.locator('[data-tab="media"]').click();
        const before = new Set(
          (await request("mediaJobs")).map((job) => job.id),
        );
        await page.locator("#batch-download").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#status")
            .textContent.includes("P2：成品下载需要有效视频轨道和音轨"),
        );
        assert.match(
          await page.locator("#status").textContent(),
          /已加入 1 个任务/,
        );
        const added = (await request("mediaJobs")).filter(
          (job) => !before.has(job.id),
        );
        assert.equal(added.length, 1);
        assert.equal(added[0].cid, 1234);
        await waitJob(added[0].id);
        await waitIdle();
        await fixture();
        await worker.evaluate(() => resourceCache.clear());
      },
    );
    await check(
      "HTTP failure is persistent and retry succeeds without helper",
      async () => {
        mode = "fail";
        const job = await enqueue();
        const failed = await waitJob(job.id, "failed");
        assert.match(failed.error, /403/);
        await waitIdle();
        mode = "ok";
        await request("mediaAction", { jobId: job.id, action: "retry" });
        await waitJob(job.id);
        await waitIdle();
      },
    );
    await check(
      "Cancel a stalled download promptly, clean OPFS and release offscreen",
      async () => {
        mode = "slow";
        releaseSlow = null;
        const job = await enqueue();
        for (let i = 0; i < 100 && !releaseSlow; i++)
          await new Promise((r) => setTimeout(r, 30));
        assert.ok(releaseSlow);
        await assert.rejects(
          request("mediaAction", { jobId: job.id, action: "delete" }),
          /停止/,
        );
        await request("mediaAction", { jobId: job.id, action: "cancel" });
        await waitJob(job.id, "cancelled");
        mode = "ok";
        releaseSlow();
        await waitIdle();
        const count = await page.evaluate(async () => {
          let count = 0;
          const dir = await (
            await navigator.storage.getDirectory()
          ).getDirectoryHandle("lens-remux-v1");
          for await (const entry of dir.keys()) count++;
          return count;
        });
        assert.equal(count, 0);
        await request("mediaAction", { jobId: job.id, action: "delete" });
        assert.equal(
          (await request("mediaJobs")).some((item) => item.id === job.id),
          false,
        );
      },
    );
    await check(
      "Worker recovery preserves active offscreen task and fails interrupted orphan safely",
      async () => {
        mode = "slow";
        releaseSlow = null;
        const job = await enqueue();
        for (let i = 0; i < 100 && !releaseSlow; i++)
          await new Promise((r) => setTimeout(r, 30));
        assert.ok(releaseSlow);
        // Exercise exactly the cold-start reconciliation path while the live
        // offscreen document holds the in-flight request and OPFS handles.
        const lifecycle = await context.newCDPSession(page);
        await lifecycle.send("ServiceWorker.enable");
        await worker.evaluate(() => {
          globalThis.recoverySentinel = "before-stop";
        });
        await lifecycle.send("ServiceWorker.stopAllWorkers");
        const jobs = await request("mediaJobs");
        worker =
          context
            .serviceWorkers()
            .find((item) => item.url() === base + "background.js") ||
          (await context.waitForEvent("serviceworker"));
        assert.equal(
          await worker.evaluate(() => globalThis.recoverySentinel),
          undefined,
          "Stopping the worker discarded its JavaScript globals",
        );
        await fixture(worker);
        assert.equal(jobs.find((j) => j.id === job.id).state, "processing");
        mode = "ok";
        releaseSlow();
        await waitJob(job.id);
        await waitIdle();
        await page.evaluate(async () => {
          const { lensMediaJobs: jobs } =
            await chrome.storage.local.get("lensMediaJobs");
          jobs.push({
            id: "orphan-test",
            engine: "browser",
            kind: "remux",
            format: "mp4",
            state: "processing",
            title: "Interrupted",
            part: "QA",
            duration: 1,
          });
          await chrome.storage.local.set({ lensMediaJobs: jobs });
        });
        await lifecycle.send("ServiceWorker.stopAllWorkers");
        const recovered = await request("mediaJobs");
        worker =
          context
            .serviceWorkers()
            .find((item) => item.url() === base + "background.js") ||
          (await context.waitForEvent("serviceworker"));
        await fixture(worker);
        assert.equal(
          recovered.find((j) => j.id === "orphan-test").state,
          "failed",
        );
      },
    );
    await check(
      "Completed-record clearing during slow cleanup preserves the next distinct queued job",
      async () => {
        mode = "slow";
        releaseSlow = null;
        const first = await enqueue();
        for (let i = 0; i < 100 && !releaseSlow; i++)
          await new Promise((r) => setTimeout(r, 30));
        assert.ok(releaseSlow);
        const next = await enqueue(2345);
        assert.equal(next.state, "waiting");
        const stored = await page.evaluate(() =>
          chrome.storage.local.get(null),
        );
        assert.ok(
          !JSON.stringify(stored).includes(origin),
          "Signed source URLs must remain in memory only",
        );
        mode = "ok";
        releaseSlow();
        await waitJob(first.id);
        const remaining = await request("clearMediaJobs");
        assert.ok(!remaining.some((job) => job.id === first.id));
        assert.ok(remaining.some((job) => job.id === next.id));
        await request("mediaJobs");
        await waitJob(next.id);
        await waitIdle();
      },
    );
    await check(
      "Insufficient OPFS quota fails clearly and cleans the private cache",
      async () => {
        const storage = await context.newCDPSession(page);
        await storage.send("Storage.overrideQuotaForOrigin", {
          origin: base.slice(0, -1),
          quotaSize: 1024 * 1024,
        });
        try {
          const job = await enqueue();
          const failed = await waitJob(job.id, "failed");
          assert.match(failed.error, /存储空间不足/);
          await waitIdle();
          const entries = await page.evaluate(async () => {
            const dir = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle("lens-remux-v1");
            const names = [];
            for await (const name of dir.keys()) names.push(name);
            return names;
          });
          assert.deepEqual(entries, []);
        } finally {
          await storage.send("Storage.overrideQuotaForOrigin", {
            origin: base.slice(0, -1),
          });
        }
      },
    );
    await check(
      "Cancellation during offscreen initialization never starts a media request",
      async () => {
        const before = ranges.length;
        await page.evaluate(
          ({ bvid }) => {
            globalThis.pendingEnqueue = chrome.runtime.sendMessage({
              op: "enqueueVideo",
              bvid,
              cid: 1234,
              videoKey: "video:80:avc1",
              audioKey: "audio:30280:mp4a",
              container: "mp4",
            });
          },
          { bvid },
        );
        let initializing;
        for (let i = 0; i < 100; i++) {
          initializing = await page.evaluate(async () =>
            (
              (await chrome.storage.local.get("lensMediaJobs")).lensMediaJobs ||
              []
            ).find((job) => job.state === "waiting"),
          );
          if (initializing) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(
          initializing,
          "Caught the task while its module was initializing",
        );
        await request("mediaAction", {
          jobId: initializing.id,
          action: "cancel",
        });
        await page.evaluate(() => globalThis.pendingEnqueue);
        await waitJob(initializing.id, "cancelled");
        await waitIdle();
        assert.equal(ranges.length, before);
      },
    );
    await check(
      "Deleting one completed MP4 record retains its saved file and other task records",
      async () => {
        const before = await request("mediaJobs");
        const completed = before.find(
          (job) => job.state === "completed" && job.outputFilename,
        );
        assert.ok(completed);
        const bytes = fs.readFileSync(completed.outputFilename);
        await page.locator('[data-tab="queue"]').click();
        await page.locator("#refresh-tasks").click();
        const row = page
          .locator("#media-jobs tr")
          .filter({ hasText: completed.outputFilename });
        await row
          .getByRole("button", { name: "删除记录", exact: true })
          .click();
        await row.waitFor({ state: "detached" });
        const after = await request("mediaJobs");
        assert.deepEqual(
          after.map((job) => job.id).sort(),
          before
            .filter((job) => job.id !== completed.id)
            .map((job) => job.id)
            .sort(),
        );
        assert.deepEqual(fs.readFileSync(completed.outputFilename), bytes);
      },
    );
    await check(
      "Browser status events reject forged tools-page callers",
      async () => {
        const response = await page.evaluate(() =>
          chrome.runtime.sendMessage({
            op: "browserResult",
            jobId: "orphan-test",
            state: "completed",
          }),
        );
        assert.equal(response.ok, false);
        assert.match(response.error, /仅允许/);
      },
    );
    if (process.env.TEST_CONVERT === "1")
      await require("./convert-checks.cjs")({
        check,
        request,
        waitJob,
        waitIdle,
        page,
        worker,
        root,
        directory,
        fixtures,
        bvid,
      });
    fs.writeFileSync(
      path.join(artifacts, "browser-remux-report.json"),
      JSON.stringify({ checks, ranges, outputs: directory }, null, 2),
    );
    console.log(`${checks.length} real MV3 browser-remux checks passed`);
  } finally {
    if (releaseSlow) releaseSlow();
    await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
