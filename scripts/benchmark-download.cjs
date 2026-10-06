// Controlled local-network + real Edge OPFS benchmark; no Bilibili account or
// ordinary profile is used. Optional argument is a previous remux-core.js file.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  directory = fs.mkdtempSync(path.join(root, "artifacts/download-speed-")),
  extension = path.join(directory, "extension"),
  bytes = crypto.randomBytes(32 * 1024 ** 2),
  hash = crypto.createHash("sha256").update(bytes).digest("hex"),
  latencyMs = 60;
fs.cpSync(path.join(root, "extension"), extension, { recursive: true });
const baseline = process.argv[2];
if (baseline)
  fs.copyFileSync(
    path.resolve(baseline),
    path.join(extension, "remux-baseline.js"),
  );
const manifestPath = path.join(extension, "manifest.json"),
  manifest = JSON.parse(fs.readFileSync(manifestPath));
manifest.permissions.push("downloads", "declarativeNetRequestWithHostAccess");
manifest.optional_permissions = manifest.optional_permissions.filter(
  (p) => !manifest.permissions.includes(p),
);
manifest.host_permissions = [
  ...manifest.optional_host_permissions,
  "http://127.0.0.1/*",
];
delete manifest.optional_host_permissions;
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
const backgroundPath = path.join(extension, "background.js");
fs.writeFileSync(
  backgroundPath,
  fs
    .readFileSync(backgroundPath, "utf8")
    .replace(
      /requestDomains: \[\r?\n/,
      'requestDomains: [\n            "127.0.0.1",\n',
    ),
);
let active = 0,
  peak = 0,
  requests = 0;
(async () => {
  const server = http.createServer(async (req, res) => {
    if (req.headers.referer !== "https://www.bilibili.com/") {
      res.writeHead(403);
      return res.end();
    }
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    if (!range) {
      res.writeHead(400);
      return res.end();
    }
    active++;
    peak = Math.max(peak, active);
    requests++;
    res.once("close", () => active--);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const start = Number(range[1]),
      end = Math.min(Number(range[2]), bytes.length - 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      "Content-Length": String(end - start + 1),
      "Cache-Control": "no-store",
      ETag: '"speed-fixture-v1"',
    });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(
      path.join(directory, "profile"),
      {
        headless: true,
        executablePath: process.env.TEST_BROWSER_EXECUTABLE,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(() => prepareHeaders());
    const page = await context.newPage();
    await page.goto(worker.url().replace("background.js", "tools.html"));
    const samples = [];
    for (let round = 0; round < 3; round++) {
      for (const optimized of [false, true]) {
        assert.equal(active, 0);
        peak = 0;
        requests = 0;
        const sample = await page.evaluate(
          async ({ url, optimized, baseline }) => {
            const { downloadTrack } = await import(
                !optimized && baseline
                  ? "./remux-baseline.js"
                  : "./remux-core.js"
              ),
              root = await navigator.storage.getDirectory(),
              handle = await root.getFileHandle("lens-speed-qa.bin", {
                create: true,
              }),
              output = await handle.createWritable();
            let writes = 0,
              maxWrite = 0;
            const writable = {
              async write(chunk) {
                writes++;
                maxWrite = Math.max(maxWrite, (chunk.data || chunk).byteLength);
                await output.write(chunk);
              },
              close: () => output.close(),
              abort: () => output.abort(),
            };
            const start = performance.now();
            const count = await downloadTrack(url, writable, {
              signal: new AbortController().signal,
              budget: { bytes: 0 },
              progress() {},
              concurrency: optimized ? 4 : 1,
            });
            const ms = performance.now() - start;
            // Whole-file read is only for benchmark verification, outside timing.
            const digest = await crypto.subtle.digest(
              "SHA-256",
              await (await handle.getFile()).arrayBuffer(),
            );
            const hash = [...new Uint8Array(digest)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            await root.removeEntry("lens-speed-qa.bin");
            return { ms, count, hash, writes, maxWrite };
          },
          {
            url: `http://127.0.0.1:${server.address().port}/track?round=${round}&optimized=${optimized}`,
            optimized,
            baseline: !!baseline,
          },
        );
        assert.equal(sample.count, bytes.length);
        assert.equal(sample.hash, hash);
        assert.ok(sample.maxWrite <= 2 * 1024 ** 2);
        assert.equal(peak, optimized ? 4 : 1);
        assert.equal(requests, 16);
        samples.push({
          round,
          mode: optimized
            ? "parallel-4"
            : baseline
              ? "previous-version"
              : "serial-1",
          peak,
          requests,
          ...sample,
        });
      }
    }
    const median = (mode) =>
        samples
          .filter((x) => x.mode === mode)
          .map((x) => x.ms)
          .sort((a, b) => a - b)[1],
      beforeMs = median(baseline ? "previous-version" : "serial-1"),
      afterMs = median("parallel-4"),
      report = {
        version: manifest.version,
        bytes: bytes.length,
        latencyMs,
        baseline: baseline || "optimized downloader with concurrency=1",
        beforeMs,
        afterMs,
        speedup: beforeMs / afterMs,
        samples,
      };
    fs.writeFileSync(
      path.join(root, "artifacts/download-speed-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
