/* Read-only public search using a disposable, signed-out API-only extension copy. */
const fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
(async () => {
  const source = fs.mkdtempSync(
    path.join(artifacts, "independent-live-extension-"),
  );
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "manifest.json")),
  );
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (s) => s !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify(manifest),
  );
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(artifacts, "independent-live-profile-")),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
      viewport: { width: 1440, height: 1000 },
    },
  );
  const report = {
    version: manifest.version,
    date: new Date().toISOString(),
    profile: "isolated/no account/API-only grant",
    query: "终末地基建",
    checks: [],
    errors: [],
    accuracyBenchmark: false,
  };
  try {
    await context.route("**/*", (route) =>
      ["media", "font"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker")),
      page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto(
      worker
        .url()
        .replace(
          "background.js",
          "search.html?q=" + encodeURIComponent(report.query),
        ),
    );
    await page.waitForFunction(() => ready);
    await page.locator("#submit").click();
    await page.waitForFunction(
      () => session.keyword && !session.loading,
      {},
      { timeout: 35000 },
    );
    report.checks.push(
      await page.evaluate(() => ({
        pages: session.pages,
        pool: session.pool.length,
        visible: session.selected().length,
        error: session.error,
        samples: session.pool
          .slice(0, 10)
          .map((r) => ({ bvid: r.bvid, title: r.title, clue: r.clue })),
      })),
    );
    if (await page.locator("#more").isEnabled()) {
      await page.locator("#more").click();
      await page.waitForFunction(
        () => !session.loading,
        {},
        { timeout: 35000 },
      );
      report.checks.push(
        await page.evaluate(() => ({
          pages: session.pages,
          pool: session.pool.length,
          unique: new Set(session.pool.map((r) => r.bvid)).size,
          visible: session.selected().length,
          error: session.error,
        })),
      );
    }
    await page.screenshot({
      path: path.join(artifacts, "independent-live-1440.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    report.narrowFits = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    await page.screenshot({
      path: path.join(artifacts, "independent-live-390.png"),
      fullPage: true,
    });
    const stored = await worker.evaluate(
      async () =>
        (await chrome.storage.local.get("lensSettingsV2")).lensSettingsV2 ||
        LensSettings.defaults,
    );
    report.experimentalDisabled =
      stored.modules.search === false && stored.search.fillPages === false;
    report.verified =
      report.checks.length >= 1 &&
      report.checks.every(
        (c) =>
          c.pages > 0 &&
          !c.error &&
          c.pool === c.visible &&
          (c.unique === undefined || c.unique === c.pool),
      ) &&
      report.narrowFits &&
      report.experimentalDisabled &&
      !report.errors.length;
  } catch (error) {
    report.errors.push(String(error.message).slice(0, 500));
    report.verified = false;
  } finally {
    await context.close();
    fs.writeFileSync(
      path.join(artifacts, "live-independent-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
  if (!report.verified) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
