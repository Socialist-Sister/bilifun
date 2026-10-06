/* Explicit read-only QA: isolated signed-out Edge, no media downloads or user profiles. */
const fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const source = fs.mkdtempSync(path.join(artifacts, "refill-live-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (x) => x !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(artifacts, "refill-live-profile-")),
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
      viewport: { width: 1440, height: 1000 },
    });
  const report = {
    date: new Date().toISOString(),
    version: manifest.version,
    profile: "isolated/no account, API origin only in QA copy",
  };
  try {
    await context.route("**/*", (r) =>
      ["image", "font", "media"].includes(r.request().resourceType())
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
            useVideoTags: true,
            fillPages: true,
          },
        },
      }),
    );
    await worker.evaluate(() => {
      globalThis.fillLive = [];
      const original = api.fetcher;
      api.fetcher = async (url, init) => {
        const response = await original(url, init);
        if (url.includes("/search/type")) {
          const parsed = new URL(url),
            json = await response.clone().json();
          fillLive.push({
            page: parsed.searchParams.get("page"),
            requestedSize: parsed.searchParams.get("page_size"),
            order: parsed.searchParams.get("order"),
            code: json.code,
            pageSize: json.data?.pagesize,
            returned: json.data?.result?.length,
          });
        }
        return response;
      };
    });
    await page.goto(
      "https://search.bilibili.com/all?keyword=" + encodeURIComponent("贾队长"),
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    await page.waitForFunction(() =>
      document
        .getElementById("bili-search-lens")
        ?.shadowRoot?.getElementById("stats")
        .textContent.match(/识别 [1-9]/),
    );
    for (let i = 0; i < 80; i++) {
      const text = await page
        .locator("#bili-search-lens #fill-status")
        .textContent();
      if (/已补齐|上限|末尾|失败|暂不支持|超出范围/.test(text)) break;
      await page.waitForTimeout(500);
    }
    report.page = await page.evaluate(() => {
      const shadow = document.getElementById("bili-search-lens").shadowRoot;
      const supplemental = [
        ...document.querySelectorAll("[data-lens-refill-owned]"),
      ].map((n) => ({
        id: n.dataset.videoId,
        title: n.querySelector(".lens-refill-title")?.textContent,
        source: n.querySelector(".lens-refill-source")?.textContent,
      }));
      const container =
        document.querySelector("[data-lens-refill-owned]")?.parentElement ||
        document.querySelector(".video-list.row");
      const visible = [...container.children].filter(
        (n) =>
          n.getClientRects().length &&
          getComputedStyle(n).visibility !== "hidden",
      );
      const firstRow = visible
        .filter(
          (n) =>
            Math.abs(
              n.getBoundingClientRect().y -
                visible[0].getBoundingClientRect().y,
            ) < 2,
        )
        .map((n) => ({
          x: n.getBoundingClientRect().x,
          width: n.getBoundingClientRect().width,
          owned: n.hasAttribute("data-lens-refill-owned"),
        }));
      return {
        stats: shadow.getElementById("stats").textContent,
        status: shadow.getElementById("fill-status").textContent,
        collapsedSlots: document.querySelectorAll(
          "[data-lens-search-slot-hidden]",
        ).length,
        supplemental,
        unique:
          new Set(supplemental.map((n) => n.id)).size === supplemental.length,
        firstRow,
      };
    });
    report.api = await worker.evaluate(() => fillLive);
    if (/失败|暂不支持|超出范围/.test(report.page.status))
      throw new Error(report.page.status);
    if (!report.page.supplemental.length)
      throw new Error("No supplemental videos verified");
    await page.locator("#bili-search-lens #enabled").uncheck();
    await page.waitForFunction(
      () =>
        !document.querySelector(
          "[data-lens-refill-owned],[data-lens-search-slot-hidden],[data-bili-search-lens-hidden]",
        ),
    );
    report.disableRestores = true;
  } catch (error) {
    report.error = String(error.message)
      .replace(/https?:\/\/\S+/g, "[address hidden]")
      .slice(0, 300);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(artifacts, "live-refill-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    await context.close();
  }
})();
