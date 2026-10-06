/* Actual MV3 independent search, isolated profile, API-only QA grant, no remote requests. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
let checks = 0;
async function check(name, action) {
  await action();
  checks++;
  console.log("PASS " + name);
}
async function workerWait(worker, predicate) {
  for (let i = 0; i < 100; i++) {
    if (await worker.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Worker state timed out");
}
(async () => {
  const source = fs.mkdtempSync(path.join(artifacts, "search-extension-"));
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
    fs.mkdtempSync(path.join(artifacts, "search-profile-")),
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
  try {
    await context.route("https://search.bilibili.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><div class="video-list-item" id="native"><a href="https://www.bilibili.com/video/BV1test000001"><h3 class="title">终末地基建</h3></a></div><div class="video-list-item"><a href="https://www.bilibili.com/video/BV1test000002"><h3 class="title">猫咪日常</h3></a></div>',
      }),
    );
    await context.route("https://*.hdslb.com/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#d4edf3"/><path d="M80 350 L230 120 L500 360 L650 180 L730 350" fill="#9cccd8"/></svg>',
      }),
    );
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const base = worker.url().replace("background.js", "");
    await worker.evaluate(() => {
      globalThis.searchQA = {
        mode: "success",
        calls: [],
        started: 0,
        aborted: 0,
        releases: [],
      };
      api.signature = async (params) => new URLSearchParams(params).toString();
      api.fetcher = async (url, { signal }) => {
        const parsed = new URL(url),
          keyword = parsed.searchParams.get("keyword"),
          page = Number(parsed.searchParams.get("page")),
          mode = searchQA.mode;
        searchQA.calls.push({
          path: parsed.pathname,
          keyword,
          page,
          order: parsed.searchParams.get("order"),
          pageSize: parsed.searchParams.get("page_size"),
        });
        if (parsed.pathname.includes("/tags"))
          return new Response(
            JSON.stringify({ code: 0, data: [{ tag_name: "终末地基建" }] }),
          );
        if (["hang", "late"].includes(mode)) {
          searchQA.started++;
          await new Promise((resolve, reject) => {
            const abort = () => {
              searchQA.aborted++;
              if (mode === "hang")
                reject(new DOMException("Aborted", "AbortError"));
            };
            signal.addEventListener("abort", abort, { once: true });
            searchQA.releases.push(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            });
          });
        }
        if (mode === "error")
          return new Response(JSON.stringify({ code: -412 }));
        const ids =
          keyword === "GPT6.1"
            ? [900]
            : page === 1
              ? Array.from({ length: 20 }, (_, i) => i + 1)
              : page === 2
                ? Array.from({ length: 20 }, (_, i) => i + 18)
                : [];
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              numPages: 3,
              pagesize: 20,
              result: ids.map((n) => ({
                type: "video",
                bvid: "BV1test" + String(n).padStart(6, "0"),
                aid: n,
                title:
                  n === 1
                    ? "【终末地】1.5活动基建第二阶段作业"
                    : n === 2
                      ? "终末地基建"
                      : n === 3
                        ? "GPT6.1实测"
                        : n === 4
                          ? '<img src=x onerror="alert(1)">安全标题 &amp; 字符'
                          : n === 900
                            ? "GPT6.1新测试"
                            : "武陵工厂蓝图 " + n,
                description: "测试用简介，不是实际搜索结果。",
                tag: n === 2 ? "终末地,基建" : "攻略",
                pic: "https://i0.hdslb.com/search-qa.svg",
                author: "测试 UP",
                mid: 7,
                play: 95000,
                video_review: 317,
                duration: "3:07",
                pubdate: 1720000000,
              })),
            },
          }),
        );
      };
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(base + "search.html?q=" + encodeURIComponent("终末地基建"));
    await page.waitForFunction(() => ready);
    const native = await context.newPage();
    await check(
      "Fresh installation leaves original search DOM untouched and mounts no experimental panel",
      async () => {
        await native.goto(
          "https://search.bilibili.com/video?keyword=终末地基建",
        );
        await native.waitForTimeout(250);
        assert.equal(await native.locator("#bili-search-lens").count(), 0);
        assert.equal(
          await native.locator('[data-bili-search-lens-hidden="true"]').count(),
          0,
        );
        assert.equal(await worker.evaluate(() => searchQA.calls.length), 0);
        const settings = await worker.evaluate(
          async () =>
            (await chrome.storage.local.get("lensSettingsV2")).lensSettingsV2 ||
            LensSettings.defaults,
        );
        assert.equal(settings.modules.search, false);
        assert.equal(settings.search.fillPages, false);
      },
    );
    await check(
      "Permission denial keeps an actionable empty state and performs no search request",
      async () => {
        await page.evaluate(() => {
          globalThis.originalContains = chrome.permissions.contains;
          globalThis.originalRequest = chrome.permissions.request;
          chrome.permissions.contains = async () => false;
          chrome.permissions.request = async () => false;
        });
        await page.locator("#submit").click();
        await page.waitForFunction(() =>
          document.getElementById("status").textContent.includes("未授权"),
        );
        assert.equal(await worker.evaluate(() => searchQA.calls.length), 0);
        await page.evaluate(() => {
          chrome.permissions.contains = originalContains;
          chrome.permissions.request = originalRequest;
        });
      },
    );
    async function search(query = "终末地基建") {
      const generation = await page.evaluate(() => session.generation);
      await page.locator("#query").fill(query);
      await page.locator("#submit").click();
      await page.waitForFunction(
        ({ query, generation }) =>
          session.keyword === query &&
          session.generation > generation &&
          session.pages > 0 &&
          !session.loading,
        { query, generation },
      );
    }
    await check(
      "Independent search retains all 20 candidates including separated Chinese clues and uncertain videos",
      async () => {
        await search();
        assert.equal(await page.locator(".video-card").count(), 20);
        assert.equal(await page.locator("#count").textContent(), "20");
        assert.ok(
          await page
            .getByRole("link", {
              name: "【终末地】1.5活动基建第二阶段作业",
              exact: true,
            })
            .last()
            .isVisible(),
        );
        assert.ok(
          await page.locator('[data-bvid="BV1test000003"]').isVisible(),
        );
        assert.match(await page.locator("#status").textContent(), /去重后 20/);
        assert.deepEqual(
          await worker.evaluate(() =>
            searchQA.calls
              .filter((c) => c.keyword)
              .map((c) => [c.page, c.pageSize]),
          ),
          [[1, "20"]],
        );
      },
    );
    await check(
      "Titles are safe text, covers include play/danmaku/duration and tools link is bound to the video",
      async () => {
        assert.equal(
          await page.locator('[data-bvid="BV1test000004"] img').count(),
          1,
        );
        assert.equal(await page.locator("[onerror]").count(), 0);
        assert.match(
          await page.locator('[data-bvid="BV1test000004"] h3').textContent(),
          /安全标题 & 字符/,
        );
        const first = page.locator(".video-card").first();
        assert.match(
          await first.locator(".cover-stats").textContent(),
          /9.5万.*317.*3:07/,
        );
        assert.match(
          await first
            .getByRole("link", { name: "下载 / 弹幕" })
            .getAttribute("href"),
          /tools.html\?id=BV1test000001/,
        );
      },
    );
    await check(
      "Loading more merges overlapping source pages without duplicates and own pagination packs 20 then 17",
      async () => {
        await page.locator("#more").click();
        await page.waitForFunction(
          () => session.pages === 2 && !session.loading,
        );
        assert.equal(await page.locator("#count").textContent(), "37");
        assert.equal(await page.locator(".video-card").count(), 20);
        await page.locator("#next").click();
        assert.equal(await page.locator(".video-card").count(), 17);
        const second = await page
          .locator(".video-card")
          .evaluateAll((nodes) => nodes.map((n) => n.dataset.bvid));
        await page.locator("#previous").click();
        const first = await page
          .locator(".video-card")
          .evaluateAll((nodes) => nodes.map((n) => n.dataset.bvid));
        assert.equal(new Set([...first, ...second]).size, 37);
      },
    );
    await check(
      "Manual hiding and explicit title exclusions have review and restoration; missing query clues never hide",
      async () => {
        await page
          .locator(".video-card")
          .first()
          .getByRole("button", { name: "隐藏", exact: true })
          .click();
        assert.equal(await page.locator("#count").textContent(), "36");
        await page.locator("#filter").selectOption("hidden");
        assert.equal(await page.locator(".video-card").count(), 1);
        await page.getByRole("button", { name: "恢复", exact: true }).click();
        await page.locator("#filter").selectOption("all");
        await page.locator("#exclusions").fill("GPT");
        assert.equal(await page.locator("#count").textContent(), "36");
        await page.locator("#exclusions").fill("");
        assert.equal(await page.locator("#count").textContent(), "37");
        await page.locator("#filter").selectOption("matched");
        assert.equal(await page.locator("#count").textContent(), "1");
        await page.locator("#filter").selectOption("uncertain");
        assert.equal(await page.locator("#count").textContent(), "36");
        await page.locator("#filter").selectOption("all");
      },
    );
    await check(
      "Optional video tag enrichment can confirm clues without discarding the candidate",
      async () => {
        const first = page.locator(".video-card").first();
        await first.locator("summary").click();
        await first.getByRole("button", { name: "核对视频页标签" }).click();
        await page.waitForFunction(
          () => session.pool[0].clue === "matched" && !tagReads.size,
        );
        assert.equal(await page.locator("#count").textContent(), "37");
        assert.match(
          await page.locator(".video-card").first().textContent(),
          /已核对/,
        );
      },
    );
    await check(
      "Source exhaustion is explicit, API failures retain prior pool and retry the same page",
      async () => {
        await worker.evaluate(() => {
          searchQA.mode = "error";
        });
        await page.locator("#more").click();
        await page.waitForFunction(() => session.error && !session.loading);
        assert.equal(await page.locator("#count").textContent(), "37");
        assert.equal(await page.locator("#more").textContent(), "重试读取");
        await worker.evaluate(() => {
          searchQA.mode = "success";
        });
        await page.locator("#more").click();
        await page.waitForFunction(
          () => session.pages === 3 && !session.loading,
        );
        assert.equal(await page.locator("#more").isDisabled(), true);
        assert.match(await page.locator("#status").textContent(), /已读完/);
        const calls = await worker.evaluate(() =>
          searchQA.calls.filter((c) => c.keyword).map((c) => c.page),
        );
        assert.deepEqual(calls, [1, 2, 3, 3]);
      },
    );
    await check(
      "Stopping cancels the backend request, and stale responses cannot enter a replacement search",
      async () => {
        await worker.evaluate(() => {
          searchQA.mode = "late";
        });
        await page.locator("#submit").click();
        await workerWait(worker, () => searchQA.started === 1);
        await page.locator("#stop").click();
        await workerWait(worker, () => searchQA.aborted >= 1);
        await worker.evaluate(() => {
          searchQA.mode = "success";
        });
        await search("GPT6.1");
        await worker.evaluate(() => searchQA.releases.forEach((fn) => fn()));
        await page.waitForTimeout(150);
        assert.equal(await page.locator("#count").textContent(), "1");
        assert.match(
          await page.locator(".video-card h3").textContent(),
          /GPT6.1新测试/,
        );
      },
    );
    await check(
      "The frontend deadline stops waiting and aborts a hung backend search",
      async () => {
        await worker.evaluate(() => {
          searchQA.mode = "hang";
        });
        await page.locator("#submit").click();
        await workerWait(worker, () => searchQA.started === 2);
        await page.clock.runFor(25100);
        await page.waitForFunction(() => session.error && !session.loading);
        assert.match(await page.locator("#status").textContent(), /超过 25 秒/);
        await workerWait(worker, () => searchQA.aborted >= 2);
        await worker.evaluate(() => {
          searchQA.mode = "success";
        });
      },
    );
    await check(
      "Query variants are deduplicated and candidate pagination remains independent of native pages",
      async () => {
        await page.locator(".variants summary").click();
        await page.locator("#variants").fill("终末地 基建");
        await search();
        assert.equal(await page.locator("#count").textContent(), "20");
        assert.equal(await page.evaluate(() => session.pages), 2);
        await page.locator("#variants").fill("");
      },
    );
    await check(
      "Invalid exclusion syntax cannot leave old-query cards after a replacement search",
      async () => {
        await search();
        await page.locator("#exclusions").fill('"缺少右引号');
        await search("GPT6.1");
        assert.equal(await page.locator(".video-card").count(), 1);
        assert.equal(await page.locator("#count").textContent(), "1");
        assert.equal(
          await page.locator(".video-card").getAttribute("data-bvid"),
          "BV1test000900",
        );
        assert.match(
          await page.locator(".video-card h3").textContent(),
          /GPT6.1新测试/,
        );
        assert.match(await page.locator("#status").textContent(), /未闭合/);
        await page.locator("#exclusions").fill("");
      },
    );
    await check(
      "Draft query, source order and variants disable more reads while the submitted conditions remain visible",
      async () => {
        await page.locator("#order").selectOption("pubdate");
        await page.locator("#variants").fill("已提交别名");
        await search("已提交主查询");
        const active = page.locator("#active-search");
        assert.match(await active.textContent(), /已提交主查询/);
        assert.match(await active.textContent(), /最新发布/);
        assert.match(await active.textContent(), /已提交别名/);
        assert.equal(await page.locator("#more").isDisabled(), false);
        const calls = await worker.evaluate(() => searchQA.calls.length);
        for (const [id, draft, committed] of [
          ["query", "尚未提交的查询", "已提交主查询"],
          ["order", "click", "pubdate"],
          ["variants", "尚未提交的别名", "已提交别名"],
        ]) {
          if (id === "order") await page.locator("#order").selectOption(draft);
          else await page.locator("#" + id).fill(draft);
          assert.equal(await page.locator("#more").isDisabled(), true, id);
          assert.match(await active.textContent(), /已提交主查询/);
          assert.match(await active.textContent(), /最新发布/);
          assert.match(await active.textContent(), /条件已修改/);
          assert.equal(
            await worker.evaluate(() => searchQA.calls.length),
            calls,
          );
          if (id === "order")
            await page.locator("#order").selectOption(committed);
          else await page.locator("#" + id).fill(committed);
          assert.equal(await page.locator("#more").isDisabled(), false, id);
        }
        await page.locator("#variants").fill("");
        await page.locator("#order").selectOption("totalrank");
        await search();
      },
    );
    await check(
      "Existing enabled installs migrate off once; explicit experimental opt-in remains enabled after reload",
      async () => {
        await worker.evaluate(() =>
          chrome.storage.local.set({
            lensSettingsV2: {
              version: 2,
              modules: { search: true },
              search: {
                fillPages: true,
                relevanceVersion: 1,
                exclusions: "抽奖",
              },
              downloads: { concurrent: 3 },
            },
          }),
        );
        const options = await context.newPage();
        await options.goto(base + "options.html");
        await options.waitForFunction(() => settings);
        assert.equal(
          await options.locator('[data-setting="modules.search"]').isChecked(),
          false,
        );
        assert.equal(
          await options
            .locator('[data-setting="search.fillPages"]')
            .isChecked(),
          false,
        );
        assert.equal(
          await options
            .locator('[data-setting="search.exclusions"]')
            .inputValue(),
          "抽奖",
        );
        await options.locator('[data-setting="modules.search"]').check();
        await options.locator('[data-setting="search.useVideoTags"]').uncheck();
        await options.locator('button[type="submit"]').click();
        await options.waitForFunction(() =>
          document.getElementById("status").textContent.includes("设置已保存"),
        );
        await options.reload();
        await options.waitForFunction(() => settings);
        assert.equal(
          await options.locator('[data-setting="modules.search"]').isChecked(),
          true,
        );
        await native.reload();
        await native.locator("#bili-search-lens #stats").waitFor();
        assert.ok(await native.locator("#native").isVisible());
        await options.locator('[data-setting="modules.search"]').uncheck();
        await options.locator('button[type="submit"]').click();
      },
    );
    await check(
      "Popup main action carries the native query into the independent page without automatically searching",
      async () => {
        const popup = await context.newPage();
        await popup.goto(base + "popup.html");
        await popup.evaluate(() => {
          chrome.tabs.query = async () => [
            {
              url:
                "https://search.bilibili.com/video?keyword=" +
                encodeURIComponent("终末地基建"),
            },
          ];
        });
        const opened = context.waitForEvent("page");
        await popup.locator("#search").click();
        const searchPage = await opened;
        await searchPage.waitForLoadState();
        await searchPage.waitForFunction(() => ready);
        assert.equal(
          await searchPage.locator("#query").inputValue(),
          "终末地基建",
        );
        assert.equal(await searchPage.locator(".video-card").count(), 0);
        await searchPage.close();
        await popup.close();
      },
    );
    await check(
      "Desktop and 390px results fit the viewport, titles occupy two lines, and no page script errors occur",
      async () => {
        await page.screenshot({
          path: path.join(artifacts, "independent-search-1440.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        assert.ok(
          await page
            .locator(".video-card h3")
            .first()
            .evaluate((el) => el.getBoundingClientRect().height <= 44),
        );
        await page.screenshot({
          path: path.join(artifacts, "independent-search-390.png"),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
      },
    );
    fs.writeFileSync(
      path.join(artifacts, "independent-search-report.json"),
      JSON.stringify(
        {
          version: manifest.version,
          checks,
          date: new Date().toISOString(),
          fixture: true,
          network: "mocked API; API-only disposable grant",
          accuracyBenchmark: false,
        },
        null,
        2,
      ),
    );
    console.log(checks + " actual-extension independent search checks passed");
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
