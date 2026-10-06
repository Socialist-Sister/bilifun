/* Optional read-only relevance probe: fresh profile, no login, no user cookies. */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const query = process.argv[2] || "gpt6.1";
if (query.length > 200) throw new Error("Query too long");
(async () => {
  const profile = fs.mkdtempSync(
    path.join(artifacts, "relevance-live-profile-"),
  );
  const extension = path.join(root, "extension");
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
    query,
    profile: "isolated/no account",
    checks: [],
  };
  try {
    await context.route("**/*", (route) =>
      ["image", "media", "font"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
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
    for (const category of ["video", "all"]) {
      try {
        await page.goto(
          `https://search.bilibili.com/${category}?keyword=${encodeURIComponent(query)}`,
          { waitUntil: "domcontentloaded", timeout: 30000 },
        );
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            ?.shadowRoot?.getElementById("stats")
            .textContent.match(/识别 [1-9]/),
        );
        const result = await page.evaluate(() => {
          const shadow = document.getElementById("bili-search-lens").shadowRoot;
          const selector =
            ".video-list-item, .bili-video-card, .video-item.matrix, .video-page-card-small, .small-item";
          const samples = [...document.querySelectorAll(selector)]
            .filter(
              (card) =>
                !card.parentElement?.closest(selector) &&
                (card.getClientRects().length ||
                  card.hasAttribute("data-bili-search-lens-hidden")),
            )
            .map((card) => {
              const title = card.querySelector(
                ".bili-video-card__info--tit, .bili-video-card__info--title, .title",
              );
              return {
                title: (
                  title?.getAttribute("title") ||
                  title?.textContent ||
                  ""
                ).trim(),
                hidden: card.hasAttribute("data-bili-search-lens-hidden"),
              };
            })
            .filter((card) => card.title)
            .slice(0, 50);
          return {
            category: location.pathname,
            mode: shadow.getElementById("mode").value,
            statistics: shadow.getElementById("stats").textContent,
            notice: shadow.getElementById("notice").textContent,
            hiddenReasons: shadow.getElementById("reasons").textContent,
            samples,
          };
        });
        await page.locator("#bili-search-lens #enabled").uncheck();
        await page.waitForFunction(
          () => !document.querySelector("[data-bili-search-lens-hidden]"),
        );
        result.disableRestores = true;
        await page.locator("#bili-search-lens #enabled").check();
        report.checks.push(result);
      } catch (error) {
        report.checks.push({
          category,
          error: String(error.message)
            .replace(/https?:\/\/\S+/g, "[hidden]")
            .slice(0, 300),
        });
        break;
      }
    }
    fs.writeFileSync(
      path.join(artifacts, "live-relevance-report.json"),
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
