/* Read-only live-site QA. An isolated profile contains only this extension. */
const fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, "search-live-profile-"));
const extension = path.join(root, "extension");
(async () => {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const report = {
    date: new Date().toISOString(),
    session: "isolated browser/no account",
    checks: [],
  };
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      const value = await LensSettings.load();
      value.modules.search = true; // Explicit QA opt-in to the legacy experiment.
      value.search.fillPages = false;
      value.search.useVideoTags = false;
      await LensSettings.save(value);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    for (const route of [
      "video?keyword=" + encodeURIComponent("机械键盘 静音"),
      "video?page=2&keyword=" + encodeURIComponent("机械键盘 静音"),
      "all?keyword=" + encodeURIComponent("机械键盘"),
    ]) {
      try {
        await page.goto("https://search.bilibili.com/" + route, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForSelector("#bili-search-lens");
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".video-list-item,.bili-video-card")
              .length > 0,
        );
        const result = await page.evaluate(() => {
          const host = document.getElementById("bili-search-lens");
          return {
            route: location.pathname,
            page: Number(new URL(location.href).searchParams.get("page") || 1),
            panel: !!host,
            statistics: host.shadowRoot.getElementById("stats").textContent,
            hidden: document.querySelectorAll("[data-bili-search-lens-hidden]")
              .length,
            cards: document.querySelectorAll(
              ".video-list-item,.bili-video-card",
            ).length,
          };
        });
        await page.locator("#bili-search-lens #enabled").uncheck();
        await page.waitForFunction(
          () =>
            document.querySelectorAll("[data-bili-search-lens-hidden]")
              .length === 0,
        );
        result.disableRestores = true;
        await page.locator("#bili-search-lens #enabled").check();
        await page.waitForFunction(
          () =>
            document
              .getElementById("bili-search-lens")
              .shadowRoot.getElementById("enabled").checked,
        );
        report.checks.push(result);
      } catch (error) {
        report.checks.push({
          route: route.split("?")[0],
          error: String(error.message)
            .replace(/https?:\/\/\S+/g, "[hidden]")
            .slice(0, 300),
        });
      }
    }
    fs.writeFileSync(
      path.join(artifacts, "live-search-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
