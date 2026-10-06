/* Real MV3 messages, permission boundary, queue and content scripts; public API responses are fixtures. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const samples = [
  ["exact", "贾队长经典语录", "av1101"],
  ["tagged", "舍不得的他他他", "av1102"],
  ["duplicate", "舍不得的他他他（同一视频）", "av1102"],
  ["other", "猫咪日常", "av1103"],
  ["failure", "没有明确标题的视频", "av1104"],
  ["blocked", "贾队长抽奖", "av1105"],
];
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;padding:24px}main{display:grid;grid-template-columns:repeat(2,300px);gap:20px}.video-list-item{padding:24px;border:1px solid #aaa}</style><body><h1>标签筛选 · 本地回归样例</h1><main>${samples.map(([id, title, videoId]) => `<div id="${id}" class="video-list-item"><a href="https://www.bilibili.com/video/${videoId}"><h3 class="title">${title}</h3></a></div>`).join("")}</main>`;
let checks = 0;
async function check(name, action) {
  await action();
  checks++;
  console.log("PASS " + name);
}
async function launch(source) {
  const profile = fs.mkdtempSync(path.join(artifacts, "tag-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${source}`,
      `--load-extension=${source}`,
    ],
    viewport: { width: 1366, height: 960 },
  });
  await context.route("https://search.bilibili.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage(),
    options = await context.newPage();
  await options.goto(worker.url().replace("background.js", "options.html"));
  await options.evaluate(() =>
    chrome.storage.local.set({
      lensSettingsV2: {
        version: 2,
        searchExperienceVersion: 1,
        modules: { search: true },
        search: {
          mode: "all",
          relevanceVersion: 1,
          fillPages: false,
          useVideoTags: true,
          exclusions: "抽奖",
        },
      },
    }),
  );
  return { context, worker, page, options };
}
const controls = (page, id) => page.locator("#bili-search-lens #" + id);
async function waitHidden(page, count) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-bili-search-lens-hidden="true"]')
        .length === count,
    count,
  );
}
async function waitWorker(worker, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await worker.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Worker condition timed out");
}
(async () => {
  const denied = await launch(path.join(root, "extension"));
  try {
    await denied.page.goto("https://search.bilibili.com/video?keyword=贾队长");
    await controls(denied.page, "stats").waitFor();
    await denied.page.waitForFunction(() =>
      document
        .getElementById("bili-search-lens")
        .shadowRoot.getElementById("tag-status")
        .textContent.includes("尚未授权"),
    );
    await check(
      "Without API permission, page evidence filters results and cannot bypass explicit exclusions",
      async () => {
        await waitHidden(denied.page, 5);
        assert.equal(await denied.page.locator("#tagged").isVisible(), false);
        assert.match(
          await controls(denied.page, "tag-status").textContent(),
          /尚未授权/,
        );
        const reply = await denied.options.evaluate(() =>
          chrome.runtime.sendMessage({
            op: "videoTags",
            id: "av1102",
            token: "manual",
          }),
        );
        assert.equal(reply.ok, false);
        assert.match(reply.error, /授权/);
        assert.equal(
          await denied.worker.evaluate(() => videoTags.cache.size),
          0,
        );
      },
    );
    await check("Pure title filtering remains an explicit choice", async () => {
      await controls(denied.page, "video-tags").uncheck();
      await waitHidden(denied.page, 5);
      await controls(denied.page, "video-tags").check();
      await waitHidden(denied.page, 5);
      await controls(denied.page, "mode").selectOption("related");
      await waitHidden(denied.page, 5);
      assert.equal(await denied.page.locator("#other").isVisible(), false);
    });
  } finally {
    await denied.context.close();
  }
  // Only this disposable copy has API access pregranted; production permissions stay optional.
  const source = fs.mkdtempSync(path.join(artifacts, "tag-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (origin) => origin !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const { context, worker, page, options } = await launch(source);
  try {
    await worker.evaluate(() => {
      globalThis.tagQA = {
        hold: true,
        release: [],
        calls: [],
        active: 0,
        maximum: 0,
        aborted: 0,
      };
      api.fetcher = async (url, init) => {
        const parsed = new URL(url),
          id = "av" + parsed.searchParams.get("aid");
        if (parsed.pathname !== "/x/tag/archive/tags")
          throw new Error("Unexpected API path");
        tagQA.calls.push(id);
        tagQA.active++;
        tagQA.maximum = Math.max(tagQA.maximum, tagQA.active);
        try {
          await new Promise((resolve, reject) => {
            const abort = () => {
              tagQA.aborted++;
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
            if (tagQA.hold) tagQA.release.push(done);
            else setTimeout(done, 30);
          });
          return new Response(
            JSON.stringify(
              id === "av1104"
                ? { code: -412 }
                : {
                    code: 0,
                    data: (id === "av1102"
                      ? ["高能", "舞台秀", "贾队长"]
                      : ["猫咪"]
                    ).map((tag_name) => ({ tag_name })),
                  },
            ),
          );
        } finally {
          tagQA.active--;
        }
      };
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("https://search.bilibili.com/video?keyword=贾队长");
    await controls(page, "stats").waitFor();
    await check(
      "Pending real-worker tag requests cannot hide tag-only matches",
      async () => {
        await waitWorker(worker, () => tagQA.calls.length === 2);
        await waitHidden(page, 1);
        assert.ok(await page.locator("#tagged").isVisible());
        assert.ok(await page.locator("#other").isVisible());
        assert.match(
          await controls(page, "tag-status").textContent(),
          /待核对/,
        );
      },
    );
    await worker.evaluate(() => {
      tagQA.hold = false;
      tagQA.release.splice(0).forEach((release) => release());
    });
    await check(
      "Actual video tags rescue both copies while unrelated results are hidden after success",
      async () => {
        await waitHidden(page, 3);
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("tag-status")
            .textContent.includes("查询失败"),
        );
        assert.ok(await page.locator("#tagged").isVisible());
        assert.ok(await page.locator("#duplicate").isVisible());
        assert.equal(await page.locator("#other").isVisible(), false);
        const state = await worker.evaluate(() => ({
          calls: tagQA.calls,
          maximum: tagQA.maximum,
        }));
        assert.equal(state.calls.filter((id) => id === "av1102").length, 1);
        assert.equal(state.calls.includes("av1101"), false);
        assert.equal(state.calls.includes("av1105"), false);
        assert.ok(state.maximum <= 2);
        assert.match(
          await controls(page, "tag-status").textContent(),
          /2 个通过标签保留/,
        );
      },
    );
    await check(
      "Risk-control failure falls back to page evidence and does not retry automatically",
      async () => {
        assert.equal(await page.locator("#failure").isVisible(), false);
        assert.equal(
          await worker.evaluate(
            () => tagQA.calls.filter((id) => id === "av1104").length,
          ),
          1,
        );
      },
    );
    await check(
      "Successful tags persist and a reload uses cached data rather than requesting each card again",
      async () => {
        const stored = await worker.evaluate(() =>
          chrome.storage.local.get("lensVideoTags"),
        );
        assert.ok(
          stored.lensVideoTags.some(
            (row) => row.id === "av1102" && row.tags.includes("贾队长"),
          ),
        );
        await page.reload();
        await controls(page, "stats").waitFor();
        await waitHidden(page, 3);
        assert.equal(
          await worker.evaluate(
            () => tagQA.calls.filter((id) => id === "av1102").length,
          ),
          1,
        );
      },
    );
    await check(
      "Cautious mode also confirms titleless relevance using the true tags",
      async () => {
        await controls(page, "mode").selectOption("related");
        await waitHidden(page, 3);
        assert.match(
          await controls(page, "tag-status").textContent(),
          /2 个通过标签保留/,
        );
      },
    );
    await check(
      "Disabling filtering cancels in-flight tag requests and restores all cards",
      async () => {
        await worker.evaluate(() => {
          tagQA.hold = true;
        });
        await page.locator("#other a").evaluate((node) => {
          node.href = "https://www.bilibili.com/video/av1200";
        });
        await waitWorker(worker, () => tagQA.calls.includes("av1200"));
        await controls(page, "enabled").uncheck();
        await waitHidden(page, 0);
        await waitWorker(worker, () => tagQA.aborted > 0);
        await worker.evaluate(() => {
          tagQA.hold = false;
          tagQA.release.splice(0).forEach((release) => release());
        });
        await controls(page, "enabled").check();
        await waitHidden(page, 3);
      },
    );
    await check(
      "Reused card href changes cannot inherit another video's cached tags",
      async () => {
        await controls(page, "mode").selectOption("all");
        await page.locator("#tagged a").evaluate((node) => {
          node.href = "https://www.bilibili.com/video/av1300";
        });
        await waitHidden(page, 4);
        assert.equal(await page.locator("#tagged").isVisible(), false);
        assert.ok(await page.locator("#duplicate").isVisible());
      },
    );
    await check(
      "Cache cleanup cancels queued metadata and removes persisted public tag records",
      async () => {
        const reply = await options.evaluate(() =>
          chrome.runtime.sendMessage({ op: "clearCache" }),
        );
        assert.equal(reply.ok, true);
        const stored = await worker.evaluate(() =>
          chrome.storage.local.get("lensVideoTags"),
        );
        assert.deepEqual(stored.lensVideoTags, []);
      },
    );
    await check(
      "SPA query changes cancel old lookups and cannot apply the previous search decision",
      async () => {
        const aborted = await worker.evaluate(() => {
          tagQA.hold = true;
          return tagQA.aborted;
        });
        await page.locator("#tagged a").evaluate((node) => {
          node.href = "https://www.bilibili.com/video/av1400";
        });
        await waitWorker(worker, () => tagQA.calls.includes("av1400"));
        await page.evaluate(() =>
          history.pushState({}, "", "/video?keyword=猫咪&page=3"),
        );
        await page.waitForFunction(
          () =>
            document
              .getElementById("bili-search-lens")
              .shadowRoot.getElementById("query").value === "猫咪",
        );
        await waitWorker(worker, () => tagQA.aborted > 1);
        assert.ok((await worker.evaluate(() => tagQA.aborted)) > aborted);
        await worker.evaluate(() => {
          tagQA.hold = false;
          tagQA.release.splice(0).forEach((release) => release());
        });
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("tag-status")
            .textContent.includes("查询失败"),
        );
        assert.equal(await controls(page, "query").inputValue(), "猫咪");
        assert.ok(await page.locator("#tagged").isVisible());
      },
    );
    await check(
      "Lookup budget stops at 30 and overflow uses page evidence instead of bypassing filtering",
      async () => {
        await page.evaluate(() => {
          const main = document.querySelector("main");
          main.replaceChildren();
          for (let index = 0; index < 34; index++) {
            const card = document.createElement("div");
            card.className = "video-list-item";
            card.id = "budget-" + index;
            const anchor = document.createElement("a");
            anchor.href = "https://www.bilibili.com/video/av" + (2000 + index);
            const title = document.createElement("h3");
            title.className = "title";
            title.textContent = "猫咪日常";
            anchor.append(title);
            card.append(anchor);
            main.append(card);
          }
          history.pushState({}, "", "/video?keyword=贾队长&page=2");
        });
        await waitHidden(page, 34);
        assert.equal(await page.locator("#budget-33").isVisible(), false);
        assert.equal(
          await worker.evaluate(
            () =>
              tagQA.calls.filter((id) => Number(id.slice(2)) >= 2000).length,
          ),
          30,
        );
        assert.match(await controls(page, "tag-status").textContent(), /上限/);
      },
    );
    await check(
      "A stalled tag reply has a finite page deadline and cannot keep unrelated results forever",
      async () => {
        await page.clock.install();
        await worker.evaluate(() => {
          tagQA.hold = true;
        });
        await page.evaluate(() => {
          const main = document.querySelector("main");
          const card = document.createElement("div");
          card.className = "video-list-item";
          const anchor = document.createElement("a");
          anchor.href = "https://www.bilibili.com/video/av3000";
          const title = document.createElement("h3");
          title.className = "title";
          title.textContent = "猫咪日常";
          anchor.append(title);
          card.append(anchor);
          main.replaceChildren(card);
          history.pushState({}, "", "/video?keyword=贾队长&page=4");
        });
        await page.clock.runFor(1000);
        await waitWorker(worker, () => tagQA.calls.includes("av3000"));
        await waitHidden(page, 0);
        await page.clock.fastForward(26000);
        await page.clock.runFor(500);
        await waitHidden(page, 1);
        assert.match(
          await controls(page, "tag-status").textContent(),
          /查询失败/,
        );
        await worker.evaluate(() => {
          tagQA.hold = false;
          tagQA.release.splice(0).forEach((release) => release());
        });
        await page.clock.runFor(500);
        await waitHidden(page, 1);
        await page.clock.resume();
      },
    );
    await check(
      "New tag controls are safe text, fit a narrow window and report the installed version",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const box = await page.locator("#bili-search-lens").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 391);
        assert.match(
          await controls(page, "scope").textContent(),
          new RegExp("版本 " + manifest.version.replaceAll(".", "\\.")),
        );
        assert.deepEqual(errors, []);
      },
    );
    console.log(`${checks} actual-extension tag checks passed`);
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
