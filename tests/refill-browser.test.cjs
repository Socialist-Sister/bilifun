/* Actual MV3 scripts, synthetic search responses, disposable browser profiles. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
const videoId = (n) => "BV1fill" + String(n).padStart(6, "0");
const titles = [
  "猫咪日常",
  "贾队长经典语录",
  "普通生活记录",
  "贾队长名场面",
  "家常做菜",
  "无关日常",
];
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;margin:24px}.video-list{display:flex;flex-wrap:wrap;width:900px;max-width:100%}.col_3{width:33.3333%;padding:8px;box-sizing:border-box}.bili-video-card{height:110px;border:1px solid #aaa;padding:8px}.col_3 p{margin:4px}.sidebar{margin-top:20px}@media(max-width:500px){.col_3{width:50%}}</style><h1>补位 · 本地回归样例</h1><div class="video-list row">${titles.map((title, n) => `<div id="slot-${n}" class="col_3"><div id="native-${n}" class="bili-video-card"><a href="https://www.bilibili.com/video/${videoId(n + 1)}"><h3 class="title">${title}</h3></a></div></div>`).join("")}</div><div class="sidebar"><div id="mixed-slot" class="col_3"><div class="bili-video-card"><a href="https://www.bilibili.com/video/${videoId(90)}"><h3 class="title">猫咪杂谈</h3></a></div><p id="neighbor">其他独立内容</p></div></div>`;
const url = (page) =>
  "https://search.bilibili.com/all?keyword=" +
  encodeURIComponent("贾队长") +
  "&order=pubdate&duration=1&tids=22&page=" +
  page;
const control = (page, id) => page.locator("#bili-search-lens #" + id);
let checks = 0;
async function check(name, action) {
  await action();
  checks++;
  console.log("PASS " + name);
}
async function waitWorker(worker, action) {
  for (let i = 0; i < 100; i++) {
    if (await worker.evaluate(action)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Worker condition timed out");
}
async function launch(source) {
  fs.mkdirSync(artifacts, { recursive: true });
  const profile = fs.mkdtempSync(path.join(artifacts, "refill-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${source}`,
      `--load-extension=${source}`,
    ],
    viewport: { width: 1366, height: 960 },
  });
  await context.route("https://search.bilibili.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: fixture }),
  );
  await context.route("https://*.hdslb.com/**", (r) => r.abort());
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    options = await context.newPage(),
    page = await context.newPage();
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
  return { context, worker, options, page };
}
async function waitAdded(page, count) {
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-lens-refill-owned]").length === n,
    count,
  );
}
(async () => {
  const denied = await launch(path.join(root, "extension"));
  try {
    await denied.page.goto(url(1));
    await control(denied.page, "stats").waitFor();
    await check(
      "Hidden responsive wrappers collapse the gaps without hiding adjacent unrelated DOM",
      async () => {
        await denied.page.waitForFunction(
          () =>
            document.querySelectorAll('[data-lens-search-slot-hidden="true"]')
              .length === 4,
        );
        assert.ok(await denied.page.locator("#neighbor").isVisible());
        assert.ok(await denied.page.locator("#mixed-slot").isVisible());
        const positions = await denied.page
          .locator(".video-list")
          .evaluate((container) => {
            const rect = container.getBoundingClientRect();
            return [
              rect.x,
              ...[1, 3].map(
                (n) =>
                  document.getElementById("slot-" + n).getBoundingClientRect()
                    .x,
              ),
            ];
          });
        assert.ok(Math.abs(positions[0] - positions[1]) < 1);
        assert.ok(Math.abs(positions[2] - positions[1] - 300) < 1);
        await control(denied.page, "enabled").uncheck();
        assert.ok(await denied.page.locator("#slot-0").isVisible());
        await control(denied.page, "enabled").check();
      },
    );
    await check(
      "No optional API permission is requested implicitly and page compaction still works",
      async () => {
        await denied.page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("fill-status")
            .textContent.includes("授权"),
        );
        await waitAdded(denied.page, 0);
        const deniedReply = await denied.options.evaluate(() =>
          chrome.runtime.sendMessage({
            op: "refillPage",
            url: "https://search.bilibili.com/video?keyword=贾队长&page=1",
            page: 2,
            pageSize: 6,
            token: "own-page",
          }),
        );
        assert.equal(deniedReply.ok, false);
      },
    );
  } finally {
    await denied.context.close();
  }
  const source = fs.mkdtempSync(path.join(artifacts, "refill-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (x) => x !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const { context, worker, options, page } = await launch(source),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await worker.evaluate(() => {
      globalThis.fillQA = {
        calls: [],
        tagCalls: [],
        hold: false,
        releases: [],
        aborted: 0,
      };
      const priorHandle = handle;
      handle = (message, sender) => {
        if (message.op === "refillPage")
          fillQA.senderContext = {
            url: sender.url,
            frameId: sender.frameId,
            page: message.page,
          };
        return priorHandle(message, sender);
      };
      api.keys = { time: Date.now(), img: "a".repeat(32), sub: "b".repeat(32) };
      api.fetcher = async (url, init) => {
        const parsed = new URL(url),
          params = Object.fromEntries(parsed.searchParams);
        if (parsed.pathname === "/x/tag/archive/tags")
          fillQA.tagCalls.push(params);
        else fillQA.calls.push(params);
        await new Promise((resolve, reject) => {
          const abort = () => {
            fillQA.aborted++;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init.signal.aborted) {
            abort();
            return;
          }
          init.signal.addEventListener("abort", abort, { once: true });
          const done = () => {
            init.signal.removeEventListener("abort", abort);
            resolve();
          };
          if (fillQA.hold) fillQA.releases.push(done);
          else setTimeout(done, 30);
        });
        if (parsed.pathname === "/x/tag/archive/tags")
          return new Response(JSON.stringify({ code: 0, data: [] }));
        const id = (n) => "BV1fill" + String(n).padStart(6, "0"),
          row = (n, title, tag = "贾队长") => ({
            type: "video",
            bvid: id(n),
            aid: n,
            title,
            tag,
            author: "测试UP",
            mid: 123,
            play: 12000,
            video_review: 107,
            pubdate: Math.floor(Date.now() / 1000) - 3 * 86400,
            duration: "01:20",
            typeid: 22,
            pic: "https://unsafe.example/cover.jpg",
          });
        let rows = [],
          total = 100;
        if (params.keyword === "贾队长")
          rows =
            Number(params.page) === 2
              ? [
                  row(2, "贾队长经典语录"),
                  row(7, "舍不得的他他他"),
                  row(8, '<img src=x onerror="alert(1)">贾队长 &amp; 新视频'),
                  row(8, "贾队长重复"),
                  row(9, "猫咪日常", "猫咪"),
                ]
              : [
                  row(7, "舍不得的他他他"),
                  row(10, "贾队长补位视频"),
                  row(11, "贾队长另一个视频"),
                ];
        else if (params.keyword === "猫咪") {
          rows = [row(20, "猫咪补位", "猫咪"), row(21, "猫咪补位二", "猫咪")];
          total = Number(params.page);
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              page: Number(params.page),
              pagesize: Number(params.page_size),
              numPages: total,
              result: rows,
            },
          }),
        );
      };
    });
    await page.goto(url(1));
    await control(page, "stats").waitFor();
    await check(
      "Next pages fill the native target, deduplicate IDs and preserve source sort, duration, category and size",
      async () => {
        await waitAdded(page, 4);
        const calls = await worker.evaluate(() => fillQA.calls);
        assert.equal(calls.length, 2);
        assert.deepEqual(
          calls.map((c) => Number(c.page)),
          [2, 3],
        );
        for (const call of calls) {
          assert.equal(call.keyword, "贾队长");
          assert.equal(call.order, "pubdate");
          assert.equal(call.duration, "1");
          assert.equal(call.tids, "22");
          assert.equal(call.page_size, "6");
          assert.ok(call.w_rid);
        }
        assert.deepEqual(
          (
            await page
              .locator("[data-lens-refill-owned]")
              .evaluateAll((nodes) => nodes.map((n) => n.dataset.videoId))
          ).sort(),
          [7, 8, 10, 11].map((n) => videoId(n)).sort(),
        );
        assert.match(
          await control(page, "fill-status").textContent(),
          /已补齐/,
        );
      },
    );
    await check(
      "Search-response tags rescue titles, metadata renders as text and unsafe covers never load",
      async () => {
        const tagged = page.locator('[data-video-id="' + videoId(7) + '"]');
        assert.ok(await tagged.isVisible());
        assert.match(await tagged.textContent(), /舍不得的他他他/);
        assert.equal(await tagged.locator(".lens-refill-source").count(), 0);
        const escaped = page.locator('[data-video-id="' + videoId(8) + '"]');
        assert.match(await escaped.textContent(), /贾队长 & 新视频/);
        assert.equal(await escaped.locator("img").count(), 0);
        assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
        const rects = await page
          .locator(".video-list > :not([data-lens-search-slot-hidden])")
          .evaluateAll((nodes) =>
            nodes
              .filter((n) => n.getClientRects().length)
              .map((n) => n.getBoundingClientRect().x),
          );
        assert.equal(rects.length, 6);
        assert.ok(Math.abs(rects[2] - rects[1] - 300) < 1);
      },
    );
    await check(
      "Active refill tracks responsive widths and CSS-only visibility changes without refetching",
      async () => {
        const before = await worker.evaluate(() => fillQA.calls.length);
        await page.addStyleTag({
          content:
            "@media(max-width:500px){.video-list > .col_3:nth-child(n+4){display:none}}",
        });
        await page.setViewportSize({ width: 390, height: 960 });
        await waitAdded(page, 2);
        await page.waitForFunction(() => {
          const native = document
              .getElementById("slot-1")
              .getBoundingClientRect(),
            owned = document
              .querySelector("[data-lens-refill-owned]")
              .getBoundingClientRect();
          return Math.abs(native.width - owned.width) < 1;
        });
        await page.setViewportSize({ width: 1366, height: 960 });
        await waitAdded(page, 4);
        await page.waitForFunction(
          () =>
            Math.abs(
              document.getElementById("slot-1").getBoundingClientRect().width -
                document
                  .querySelector("[data-lens-refill-owned]")
                  .getBoundingClientRect().width,
            ) < 1,
        );
        assert.equal(await worker.evaluate(() => fillQA.calls.length), before);
      },
    );
    await check(
      "Supplemental cover statistics and author/date follow native typography without extra HTML",
      async () => {
        await page.addStyleTag({
          content:
            ".bili-video-card h3{font:500 16px/24px Arial;margin:0}.bili-video-card__info--bottom{font:13px/18px Arial;color:rgb(148,153,160);margin-top:4px}",
        });
        await page.locator("#native-1").evaluate((node) => {
          const info = document.createElement("div");
          info.className = "bili-video-card__info--bottom";
          info.textContent = "UP · 3天前";
          node.append(info);
        });
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector(".lens-refill-title"))
              .fontSize === "16px",
        );
        const card = page.locator('[data-video-id="' + videoId(7) + '"]');
        assert.equal(
          await card.locator(".lens-refill-play").textContent(),
          "1.2万",
        );
        assert.equal(
          await card.locator(".lens-refill-danmaku").textContent(),
          "107",
        );
        assert.equal(
          await card.locator(".lens-refill-duration").textContent(),
          "01:20",
        );
        assert.match(
          await card.locator(".lens-refill-info").textContent(),
          /测试UP.*3天前/,
        );
        assert.doesNotMatch(
          await card.locator(".lens-refill-info").textContent(),
          /播放/,
        );
        const layout = await card.evaluate((node) => {
          const title = node.querySelector(".lens-refill-title"),
            cover = node
              .querySelector(".lens-refill-cover")
              .getBoundingClientRect(),
            play = node
              .querySelector(".lens-refill-play")
              .getBoundingClientRect(),
            duration = node
              .querySelector(".lens-refill-duration")
              .getBoundingClientRect(),
            native = document.querySelector("#native-1 h3"),
            a = getComputedStyle(title),
            b = getComputedStyle(native);
          return {
            same: ["fontFamily", "fontSize", "fontWeight", "lineHeight"].every(
              (p) => a[p] === b[p],
            ),
            height: title.getBoundingClientRect().height,
            line: parseFloat(a.lineHeight),
            left: play.x - cover.x,
            right: cover.right - duration.right,
            statsBottom: play.bottom <= cover.bottom,
            icons: node.querySelectorAll(".lens-refill-stat svg").length,
          };
        });
        assert.equal(layout.same, true);
        assert.equal(layout.height, layout.line * 2);
        assert.ok(layout.left >= 0 && layout.right >= 0 && layout.statsBottom);
        assert.equal(layout.icons, 2);
      },
    );
    await check(
      "Show hidden and disable remove owned supplements and restore native slots; reenable reuses the pool",
      async () => {
        await control(page, "show").click();
        await waitAdded(page, 0);
        assert.ok(await page.locator("#slot-0").isVisible());
        await control(page, "show").click();
        await waitAdded(page, 4);
        await control(page, "fill-pages").uncheck();
        await waitAdded(page, 0);
        assert.equal(await page.locator("#slot-0").isVisible(), false);
        await control(page, "fill-pages").check();
        await waitAdded(page, 4);
        assert.equal(await worker.evaluate(() => fillQA.calls.length), 2);
        await control(page, "enabled").uncheck();
        await waitAdded(page, 0);
        assert.ok(await page.locator("#slot-0").isVisible());
        await control(page, "enabled").check();
        await waitAdded(page, 4);
      },
    );
    await check(
      "A website DOM refresh cannot leave a counted supplement detached from the list",
      async () => {
        const before = await worker.evaluate(() => fillQA.calls.length);
        await page
          .locator("[data-lens-refill-owned]")
          .first()
          .evaluate((node) => node.remove());
        await waitAdded(page, 4);
        assert.equal(await worker.evaluate(() => fillQA.calls.length), before);
      },
    );
    await check(
      "Pending tag evidence postpones refill and cannot report temporary retention as a completed page",
      async () => {
        const before = await worker.evaluate(() => {
          fillQA.hold = true;
          return fillQA.calls.length;
        });
        await control(page, "video-tags").check();
        await waitWorker(worker, () => fillQA.tagCalls.length >= 2);
        await waitAdded(page, 0);
        assert.match(
          await control(page, "fill-status").textContent(),
          /等待.*标签/,
        );
        assert.equal(await worker.evaluate(() => fillQA.calls.length), before);
        await worker.evaluate(() => {
          fillQA.hold = false;
          fillQA.releases.splice(0).forEach((f) => f());
        });
        await waitAdded(page, 4);
        assert.equal(await worker.evaluate(() => fillQA.calls.length), before);
        await control(page, "video-tags").uncheck();
        await waitWorker(worker, async () => {
          const records = (
            await chrome.storage.session.get("lensSearchPagesV1")
          ).lensSearchPagesV1;
          return Object.values(records || {}).some(
            (state) => state.owners["BV1fill000007"] === 1,
          );
        });
      },
    );
    await check(
      "Same-keyword page navigation resets the source page; Stop cancels the actual API request",
      async () => {
        await worker.evaluate(() => {
          fillQA.hold = true;
        });
        await page.evaluate((next) => history.pushState({}, "", next), url(5));
        await waitWorker(worker, () =>
          fillQA.calls.some((c) => c.page === "6"),
        );
        await control(page, "fill-stop").click();
        await waitWorker(worker, () => fillQA.aborted > 0);
        await waitAdded(page, 0);
        assert.match(
          await control(page, "fill-status").textContent(),
          /已停止/,
        );
        await worker.evaluate(() => {
          fillQA.hold = false;
          fillQA.releases.splice(0).forEach((f) => f());
        });
        await control(page, "fill-stop").click();
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("fill-status")
            .textContent.includes("上限"),
        );
        assert.equal(await page.locator("[data-lens-refill-owned]").count(), 0);
      },
    );
    await check(
      "SPA changes cancel old query responses and never append stale supplements",
      async () => {
        await worker.evaluate(() => {
          fillQA.hold = true;
        });
        await page.evaluate(() =>
          history.pushState({}, "", "/all?keyword=另一个主题&page=1"),
        );
        await waitWorker(worker, () =>
          fillQA.calls.some((c) => c.keyword === "另一个主题"),
        );
        await page.evaluate(() =>
          history.pushState({}, "", "/all?keyword=猫咪&page=1"),
        );
        await waitWorker(worker, () =>
          fillQA.calls.some((c) => c.keyword === "猫咪"),
        );
        await worker.evaluate(() => {
          fillQA.hold = false;
          fillQA.releases.splice(0).forEach((f) => f());
        });
        await waitAdded(page, 2);
        const texts = await page
          .locator("[data-lens-refill-owned]")
          .allTextContents();
        assert.ok(texts.every((t) => t.includes("猫咪")));
        assert.match(
          await control(page, "fill-status").textContent(),
          /结果末尾/,
        );
      },
    );
    await check(
      "Filter edits reevaluate cached supplements without forcing title literals or new requests",
      async () => {
        const before = await worker.evaluate(() => fillQA.calls.length);
        await control(page, "exclusions").fill("补位");
        await waitAdded(page, 0);
        assert.equal(await worker.evaluate(() => fillQA.calls.length), before);
        await control(page, "exclusions").fill("");
        await waitAdded(page, 2);
      },
    );
    await check(
      "No-response refill hits the shared page deadline and reports failure with an explicit retry",
      async () => {
        await worker.evaluate(() => {
          fillQA.hold = true;
        });
        await page.clock.install();
        await page.evaluate((next) => history.pushState({}, "", next), url(9));
        await page.clock.runFor(1000);
        await waitWorker(worker, () =>
          fillQA.calls.some((c) => c.page === "10"),
        );
        await page.clock.fastForward(26000);
        await page.clock.runFor(500);
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("fill-status")
            .textContent.includes("失败"),
        );
        assert.equal(await control(page, "fill-stop").isEnabled(), true);
        await control(page, "fill-pages").uncheck();
        await worker.evaluate(() => {
          fillQA.hold = false;
          fillQA.releases.splice(0).forEach((f) => f());
        });
        await page.clock.runFor(500);
        await waitAdded(page, 0);
        await page.clock.resume();
      },
    );
    await check(
      "Only search-page top frames may request bounded subsequent pages",
      async () => {
        const replies = await worker.evaluate(async () => {
          const sender = {
            id: chrome.runtime.id,
            url: "https://search.bilibili.com/video?keyword=贾队长&page=1",
            frameId: 0,
            documentId: "narrow-qa",
          };
          const replies = [];
          for (const [message, context] of [
            [
              {
                op: "refillPage",
                url: "https://search.bilibili.com/video?keyword=贾队长&page=1",
                page: 5,
                pageSize: 6,
                token: "qa",
              },
              sender,
            ],
            [
              {
                op: "refillPage",
                url: "https://search.bilibili.com/video?keyword=贾队长&page=1",
                page: 2,
                pageSize: 6,
                token: "qa",
              },
              { ...sender, frameId: 1 },
            ],
            [
              {
                op: "refillPage",
                url: "https://search.bilibili.com/video?keyword=贾队长&page=1",
                page: 2,
                pageSize: 6,
                token: "qa",
              },
              {
                ...sender,
                url: "https://www.bilibili.com/video/BV1fill000001",
              },
            ],
          ]) {
            try {
              await handle(message, context);
              replies.push(true);
            } catch {
              replies.push(false);
            }
          }
          return replies;
        });
        assert.deepEqual(replies, [false, false, false]);
      },
    );
    await check(
      "Refill preference survives reload, narrow layout fits and no runtime errors occur",
      async () => {
        await page.waitForTimeout(400);
        await page.reload();
        await control(page, "stats").waitFor();
        assert.equal(await control(page, "fill-pages").isChecked(), false);
        await page.setViewportSize({ width: 390, height: 844 });
        const box = await page.locator("#bili-search-lens").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 391);
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: path.join(artifacts, "refill-preview.png"),
          fullPage: true,
        });
      },
    );
    console.log(`${checks} actual-extension refill checks passed`);
  } finally {
    if (checks < 15)
      console.log(
        JSON.stringify(
          {
            url: page.url(),
            status: await control(page, "fill-status").textContent(),
            details: await worker.evaluate(() => ({
              calls: fillQA.calls,
              senderContext: fillQA.senderContext,
            })),
          },
          null,
          2,
        ),
      );
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
