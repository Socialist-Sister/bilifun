/* Explicit read-only visual QA: disposable signed-out Edge, public search only. */
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const source = fs.mkdtempSync(
    path.join(artifacts, "refill-style-extension-"),
  );
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (p) => p !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(artifacts, "refill-style-profile-")),
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
    date: new Date().toISOString(),
    version: manifest.version,
    pages: [],
  };
  try {
    await context.route("**/*", (r) =>
      ["font", "media"].includes(r.request().resourceType())
        ? r.abort()
        : r.continue(),
    );
    const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker")),
      page = await context.newPage();
    await page.goto(worker.url().replace("background.js", "options.html"));
    await page.evaluate(() =>
      chrome.storage.local.set({
        lensSettingsV2: {
          version: 2,
          searchExperienceVersion: 1,
          modules: { search: true },
          search: {
            mode: "related",
            relevanceVersion: 1,
            useVideoTags: false,
            fillPages: true,
          },
        },
      }),
    );
    await worker.evaluate(() => {
      globalThis.styleApiQA = [];
      const original = api.fetcher;
      api.fetcher = async (url, init) => {
        const response = await original(url, init);
        if (url.includes("/search/type")) {
          const data = await response.clone().json(),
            row = data.data?.result?.[0];
          styleApiQA.push({
            code: data.code,
            page: new URL(url).searchParams.get("page"),
            rowKeys: row ? Object.keys(row) : [],
            danmaku: row?.video_review,
            pubdate: row?.pubdate,
          });
        }
        return response;
      };
    });
    for (const kind of ["all", "video"]) {
      await page.goto(
        `https://search.bilibili.com/${kind}?keyword=${encodeURIComponent("贾队长")}`,
        { waitUntil: "domcontentloaded", timeout: 30000 },
      );
      await page.waitForFunction(
        () => document.querySelector("[data-lens-refill-owned]"),
        null,
        { timeout: 45000 },
      );
      await page.waitForTimeout(500);
      const measurement = () => {
        const owned =
            [...document.querySelectorAll("[data-lens-refill-owned]")].find(
              (n) =>
                n.querySelector(".lens-refill-play") &&
                n.querySelector(".lens-refill-danmaku") &&
                n.querySelector(".lens-refill-duration"),
            ) || document.querySelector("[data-lens-refill-owned]"),
          list = owned.parentElement;
        const native = [...list.querySelectorAll(".bili-video-card")].find(
          (n) =>
            n.getClientRects().length &&
            n.querySelector(".bili-video-card__info--bottom"),
        );
        const get = (node, selector, properties) => {
          const el = node.querySelector(selector),
            style = getComputedStyle(el);
          return Object.fromEntries(properties.map((p) => [p, style[p]]));
        };
        const font = [
          "fontFamily",
          "fontSize",
          "fontWeight",
          "lineHeight",
          "color",
        ];
        const nativeTitle = native.querySelector(".bili-video-card__info--tit"),
          title = owned.querySelector(".lens-refill-title");
        const rect = title.getBoundingClientRect(),
          cover = owned
            .querySelector(".lens-refill-cover")
            .getBoundingClientRect(),
          stats = owned
            .querySelector(".lens-refill-stats")
            .getBoundingClientRect();
        return {
          nativeTitle: get(native, ".bili-video-card__info--tit", font),
          ownedTitle: get(owned, ".lens-refill-title", font),
          nativeInfo: get(native, ".bili-video-card__info--bottom", [
            "fontSize",
            "lineHeight",
            "color",
          ]),
          ownedInfo: get(owned, ".lens-refill-info", [
            "fontSize",
            "lineHeight",
            "color",
          ]),
          nativeStats: get(native, ".bili-video-card__stats", [
            "fontSize",
            "lineHeight",
          ]),
          ownedStats: get(owned, ".lens-refill-stats", [
            "fontSize",
            "lineHeight",
          ]),
          titleHeight: rect.height,
          twoLineHeight: parseFloat(getComputedStyle(title).lineHeight) * 2,
          coverRatio: cover.width / cover.height,
          statsAtBottom: Math.abs(stats.bottom - cover.bottom) < 1,
          authorDate: owned.querySelector(".lens-refill-info").textContent,
          play: owned.querySelector(".lens-refill-play")?.textContent,
          danmaku: owned.querySelector(".lens-refill-danmaku")?.textContent,
          duration: owned.querySelector(".lens-refill-duration")?.textContent,
          sourceBadgeAbsent: !owned.querySelector(".lens-refill-source"),
          highlights: owned.querySelectorAll(".lens-refill-keyword").length,
          supplements: document.querySelectorAll("[data-lens-refill-owned]")
            .length,
        };
      };
      const wide = await page.evaluate(measurement);
      assert.deepEqual(wide.ownedTitle, wide.nativeTitle);
      assert.deepEqual(wide.ownedInfo, wide.nativeInfo);
      assert.deepEqual(wide.ownedStats, wide.nativeStats);
      assert.equal(wide.titleHeight, wide.twoLineHeight);
      assert.equal(wide.statsAtBottom, true);
      // Public rows may omit optional statistics. Absence must not invent data.
      assert.ok(wide.sourceBadgeAbsent && wide.supplements);
      await page
        .locator("#bili-search-lens")
        .evaluate((node) => (node.style.visibility = "hidden"));
      await page
        .locator("[data-lens-refill-owned]")
        .first()
        .screenshot({
          path: path.join(artifacts, `refill-style-${kind}-wide.png`),
        });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(600);
      const narrow = await page.evaluate(measurement);
      assert.deepEqual(narrow.ownedTitle, narrow.nativeTitle);
      assert.equal(narrow.titleHeight, narrow.twoLineHeight);
      await page
        .locator("[data-lens-refill-owned]")
        .first()
        .screenshot({
          path: path.join(artifacts, `refill-style-${kind}-narrow.png`),
        });
      report.pages.push({ kind, wide, narrow });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    report.api = await worker.evaluate(() => styleApiQA);
    report.verified = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.writeFileSync(
      path.join(artifacts, "live-refill-style-report.json"),
      JSON.stringify(report, null, 2),
    );
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
