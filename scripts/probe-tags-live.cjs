/* Explicit read-only probe: isolated Edge, public pages, no account or media downloads. */
const fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
(async () => {
  const source = fs.mkdtempSync(path.join(artifacts, "tags-live-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  // Pregrant only the public API origin in this disposable QA copy, not the user's extension.
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (origin) => origin !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(artifacts, "tags-live-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${source}`,
      `--load-extension=${source}`,
    ],
  });
  const report = {
    date: new Date().toISOString(),
    version: manifest.version,
    profile: "isolated/no account, API origin pregranted in QA copy",
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
      value.modules.search = true;
      value.search.fillPages = false;
      await LensSettings.save(value);
    });
    const page = await context.newPage();
    await page.goto(worker.url().replace("background.js", "options.html"));
    const direct = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        op: "videoTags",
        id: "BV1UftJ6rE4o",
        token: "public-probe",
      }),
    );
    if (!direct.ok) throw new Error(direct.error);
    report.checks.push({
      endpoint: "/x/tag/archive/tags",
      id: "BV1UftJ6rE4o",
      tags: direct.result,
    });
    await page.goto(
      "https://search.bilibili.com/all?keyword=" + encodeURIComponent("贾队长"),
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    await page.waitForFunction(
      () =>
        document
          .getElementById("bili-search-lens")
          ?.shadowRoot?.getElementById("stats")
          .textContent.match(/识别 [1-9]/),
      { timeout: 20000 },
    );
    // Finite observation window; unavailable tags fall back to page evidence.
    for (let attempt = 0; attempt < 90; attempt++) {
      const pending = await worker.evaluate(() => videoTags.jobs.size);
      const status = await page
        .locator("#bili-search-lens #tag-status")
        .textContent();
      if (
        !pending &&
        status.includes("标签核对：") &&
        !status.includes("待核对")
      )
        break;
      await page.waitForTimeout(500);
    }
    const pageData = await page.evaluate(() => {
      const shadow = document.getElementById("bili-search-lens").shadowRoot;
      const selector =
        ".video-list-item, .bili-video-card, .video-item.matrix, .video-page-card-small, .small-item";
      return {
        statistics: shadow.getElementById("stats").textContent,
        tagsStatus: shadow.getElementById("tag-status").textContent,
        cards: [...document.querySelectorAll(selector)]
          .filter((card) => !card.parentElement?.closest(selector))
          .map((card) => {
            const title = card.querySelector(
              ".bili-video-card__info--tit, .bili-video-card__info--title, .title",
            );
            const href = card.querySelector('a[href*="/video/"]')?.href || "";
            return {
              title: (
                title?.getAttribute("title") ||
                title?.textContent ||
                ""
              ).trim(),
              id: /\/video\/(BV\w{8,22}|av\d{1,16})/.exec(href)?.[1],
              hidden: card.hasAttribute("data-bili-search-lens-hidden"),
            };
          })
          .filter((card) => card.id)
          .slice(0, 40),
      };
    });
    const tags = await worker.evaluate(() =>
      Object.fromEntries(
        [...videoTags.cache].map(([id, row]) => [id, row.tags]),
      ),
    );
    pageData.confirmedWithoutTitle = pageData.cards
      .filter(
        (card) =>
          !card.title.includes("贾队长") &&
          (tags[card.id] || []).some((tag) => tag.includes("贾队长")),
      )
      .map((card) => ({ ...card, tags: tags[card.id] }));
    delete pageData.cards;
    report.checks.push(pageData);
    await page.locator("#bili-search-lens #enabled").uncheck();
    await page.waitForFunction(
      () => !document.querySelector("[data-bili-search-lens-hidden]"),
    );
    report.disableRestores = true;
  } catch (error) {
    report.error = String(error.message)
      .replace(/https?:\/\/\S+/g, "[address hidden]")
      .slice(0, 300);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(artifacts, "live-tags-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    await context.close();
  }
})();
