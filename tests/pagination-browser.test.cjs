/* Real MV3 scripts, deterministic search pages; no user profiles or network. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts"),
  id = (n) => `BV1page${String(n).padStart(6, "0")}`;
const url = (page) =>
  `https://search.bilibili.com/all?keyword=贾队长&page=${page}`;
function cards(page, allMismatch = false) {
  return Array.from({ length: 4 }, (_, index) => {
    const n = (page - 1) * 4 + index + 1;
    const title = allMismatch || n === 2 || n === 3 ? "无关猫咪" : `贾队长${n}`;
    return `<div class="col_3"><article class="bili-video-card"><a href="https://www.bilibili.com/video/${id(n)}"><h3 class="title">${title}</h3></a></article></div>`;
  }).join("");
}
const html = (page, allMismatch) =>
  `<meta charset="utf-8"><style>body{font:16px sans-serif}.list{display:flex;flex-wrap:wrap;width:800px;max-width:100%;gap:16px}.col_3{width:auto;flex:0 0 calc(25% - 12px);padding:0 8px;box-sizing:border-box}.bili-video-card{height:150px}@media(max-width:500px){.col_3{flex-basis:calc(50% - 8px)}}</style><div class="list">${cards(page, allMismatch)}</div>`;
const control = (page, name) => page.locator(`#bili-search-lens #${name}`);
async function settle(page, expected) {
  await page.waitForFunction((ids) => {
    const list = document.querySelector(".list");
    if (!list) return false;
    const visible = [
      ...[...list.querySelectorAll(".bili-video-card")]
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => node.querySelector("a").href.split("/video/")[1]),
      ...[...list.querySelectorAll("[data-lens-refill-owned]")].map(
        (node) => node.dataset.videoId,
      ),
    ];
    return JSON.stringify(visible) === JSON.stringify(ids);
  }, expected.map(id));
  await page.waitForFunction(() =>
    document
      .getElementById("bili-search-lens")
      ?.shadowRoot.getElementById("fill-status")
      .textContent.includes("已补齐"),
  );
  const visible = await page
    .locator(".list")
    .evaluate((list) => [
      ...[...list.querySelectorAll(".bili-video-card")]
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => node.querySelector("a").href.split("/video/")[1]),
      ...[...list.querySelectorAll("[data-lens-refill-owned]")].map(
        (node) => node.dataset.videoId,
      ),
    ]);
  assert.deepEqual(visible, expected.map(id));
  assert.equal(await page.locator(".lens-refill-source").count(), 0);
  await page.waitForTimeout(250); // Allow the final asynchronous ownership write.
}
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const source = fs.mkdtempSync(path.join(artifacts, "pagination-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (host) => host !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(artifacts, "pagination-profile-")),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
    },
  );
  let checks = 0;
  async function check(name, action) {
    await action();
    checks++;
    console.log("PASS " + name);
  }
  try {
    await context.route("https://search.bilibili.com/**", (route) => {
      const params = new URL(route.request().url()).searchParams,
        page = Number(params.get("page") || 1);
      return route.fulfill({
        contentType: "text/html",
        body: html(page, page === 1 && params.get("duration") === "2"),
      });
    });
    await context.route("https://i0.hdslb.com/lens-layout-qa.png", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#cde"/></svg>',
      }),
    );
    const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker")),
      options = await context.newPage(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await options.goto(worker.url().replace("background.js", "options.html"));
    await options.evaluate(() =>
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
      api.keys = { time: Date.now(), img: "a".repeat(32), sub: "b".repeat(32) };
      api.fetcher = async (url) => {
        const params = new URL(url).searchParams,
          page = Number(params.get("page"));
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              pagesize: 4,
              numPages: 30,
              result: Array.from({ length: 4 }, (_, i) => {
                const n = (page - 1) * 4 + i + 1;
                return {
                  type: "video",
                  bvid: `BV1page${String(n).padStart(6, "0")}`,
                  aid: n,
                  title: `贾队长${n}`,
                  author: "测试UP",
                  mid: 1,
                  tag: "贾队长",
                  duration: "01:20",
                  play: 500,
                  video_review: 5,
                  pic: "https://i0.hdslb.com/lens-layout-qa.png",
                };
              }),
            },
          }),
        );
      };
    });
    await check(
      "Borrowed videos disappear from subsequent native pages and later results shift forward",
      async () => {
        await page.goto(url(1));
        await settle(page, [1, 4, 5, 6]);
        await page.goto(url(2));
        await settle(page, [7, 8, 9, 10]);
        await page.goto(url(3));
        await settle(page, [11, 12, 13, 14]);
        assert.match(
          await control(page, "reasons").textContent(),
          /已在第 2 页展示/,
        );
      },
    );
    await check(
      "Reload and backwards navigation keep each page's own results",
      async () => {
        await page.reload();
        await settle(page, [11, 12, 13, 14]);
        await page.goto(url(2));
        await settle(page, [7, 8, 9, 10]);
        await page.goto(url(1));
        await settle(page, [1, 4, 5, 6]);
      },
    );
    await check(
      "SPA route changes use current page ownership despite the committed sender URL",
      async () => {
        await page.evaluate(
          ({ next, content }) => {
            history.pushState({}, "", next);
            document.querySelector(".list").innerHTML = content;
          },
          { next: url(2), content: cards(2) },
        );
        await settle(page, [7, 8, 9, 10]);
      },
    );
    await check(
      "Partial native rendering does not erase ownership when the final slot count returns",
      async () => {
        await page.evaluate(() => {
          for (const node of [...document.querySelectorAll(".list > *")].slice(
            1,
          ))
            node.remove();
        });
        await page.waitForTimeout(300);
        const retained = await options.evaluate(
          async () =>
            Object.values(
              (await chrome.storage.session.get("lensSearchPagesV1"))
                .lensSearchPagesV1,
            )[0].owners["BV1page000005"],
        );
        assert.equal(retained, 1);
        await page.evaluate(
          (content) => (document.querySelector(".list").innerHTML = content),
          cards(2),
        );
        await settle(page, [7, 8, 9, 10]);
      },
    );
    await check(
      "Tab isolation, closing-tab cleanup and identifier-only session persistence",
      async () => {
        const other = await context.newPage();
        await other.goto(url(2));
        await settle(other, [5, 6, 7, 8]);
        const records = await options.evaluate(() =>
          chrome.storage.session.get("lensSearchPagesV1"),
        );
        assert.equal(Object.keys(records.lensSearchPagesV1).length, 2);
        assert.ok(!/贾队长|https:|测试UP/.test(JSON.stringify(records)));
        await other.close();
        await options.waitForFunction(
          async () =>
            Object.keys(
              (await chrome.storage.session.get("lensSearchPagesV1"))
                .lensSearchPagesV1,
            ).length === 1,
        );
      },
    );
    await check(
      "Server filters and edited matching rules reset ownership for the changed search",
      async () => {
        await page.goto(url(2) + "&order=click");
        await settle(page, [5, 6, 7, 8]);
        await control(page, "exclusions").fill("贾队长5");
        await settle(page, [6, 7, 8, 9]);
        await control(page, "exclusions").fill("");
        await settle(page, [5, 6, 7, 8]);
      },
    );
    await check(
      "Only the top search frame may access records; fresh Store instances retain session state",
      async () => {
        const answer = await options.evaluate(() =>
          chrome.runtime.sendMessage({
            op: "searchPageRecord",
            url: "https://search.bilibili.com/all?keyword=贾队长&page=1",
            pageSize: 4,
            rule: "{}",
          }),
        );
        assert.equal(answer.ok, false);
        const state = await worker.evaluate(async () => {
          const all = (await chrome.storage.session.get("lensSearchPagesV1"))
              .lensSearchPagesV1,
            tab = Object.keys(all)[0],
            record = all[tab];
          return new LensPagination.Store(chrome.storage.session).run(
            Number(tab),
            record.scope,
            2,
          );
        });
        assert.equal(state[id(5)], 2);
        assert.deepEqual(errors, []);
      },
    );
    await check(
      "All native videos consumed by page one still produce normal responsive columns on page two",
      async () => {
        await control(page, "exclusions").fill("");
        await page.goto(url(1) + "&duration=2");
        await settle(page, [5, 6, 7, 8]);
        await page.goto(url(2) + "&duration=2");
        await settle(page, [9, 10, 11, 12]);
        const measure = async () =>
          page.locator(".list").evaluate((list) => {
            const width = list.getBoundingClientRect().width,
              nodes = [...list.querySelectorAll("[data-lens-refill-owned]")];
            const columns = innerWidth <= 500 ? 2 : 4,
              expected = (width - (columns - 1) * 16) / columns;
            return {
              width,
              expected,
              widths: nodes.map((node) => node.getBoundingClientRect().width),
              covers: nodes.map(
                (node) =>
                  node
                    .querySelector(".lens-refill-cover")
                    .getBoundingClientRect().width,
              ),
              nativeHidden: [
                ...list.querySelectorAll(".bili-video-card"),
              ].every((node) => !node.getBoundingClientRect().width),
            };
          });
        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await page.waitForTimeout(300);
          const result = await measure();
          assert.ok(result.nativeHidden);
          assert.equal(result.widths.length, 4);
          for (const width of result.widths)
            assert.ok(
              Math.abs(width - result.expected) < 1,
              JSON.stringify(result),
            );
          for (const width of result.covers)
            assert.ok(width < result.expected && width > 0);
          await page.screenshot({
            path: path.join(
              artifacts,
              `pagination-hidden-native-${viewport.width}.png`,
            ),
            fullPage: true,
          });
        }
        assert.deepEqual(errors, []);
      },
    );
    console.log(`${checks} actual-extension pagination checks passed`);
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
