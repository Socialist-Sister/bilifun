/* Headless regression tests against a local fixture; no user browser profile is used. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("extension/manifest.json"));
const fixture = read("tests/fixture.html");
const script = manifest.content_scripts[0].js
  .map((name) =>
    name === "content.js"
      ? `globalThis.lensCollectCount = 0;
         globalThis.BiliSearchLensAdapter = {
           ...globalThis.BiliSearchLensAdapter,
           collectCards: ((original) => (...args) => {
             globalThis.lensCollectCount++;
             return original(...args);
           })(globalThis.BiliSearchLensAdapter.collectCards),
         };\n` + read(`extension/${name}`)
      : read(`extension/${name}`),
  )
  .join("\n");
const css = read("extension/content.css");
const base = "https://search.bilibili.com/video?keyword=";
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
  });
  const page = await context.newPage();
  const saved = {
    lensSettingsV2: {
      version: 2,
      searchExperienceVersion: 1,
      modules: { search: true },
      search: { fillPages: false, useVideoTags: false },
    },
  };
  // Serve all network traffic from memory. Tests cannot request real Bilibili data.
  await context.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture }),
  );
  await context.exposeFunction("lensReadSettings", () => ({ ...saved }));
  await context.exposeFunction("lensSaveSettings", (value) =>
    Object.assign(saved, value),
  );
  await context.addInitScript(() => {
    globalThis.chrome = {
      storage: {
        local: {
          get: () => globalThis.lensReadSettings(),
          set: async (value) => {
            await globalThis.lensSaveSettings(value);
            globalThis.lensLastSaved = value;
          },
        },
      },
    };
  });
  async function load(keyword = "机械键盘 静音") {
    await page.goto(base + encodeURIComponent(keyword));
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.locator("#bili-search-lens #stats").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector("#bili-search-lens")
        ?.shadowRoot?.getElementById("stats")
        .textContent.includes("视频"),
    );
  }
  const control = (id) => page.locator(`#bili-search-lens #${id}`);
  async function hiddenCount(count) {
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-bili-search-lens-hidden="true"]')
          .length === expected,
      count,
    );
  }
  try {
    await check(
      "manifest restricts injection and makes download permissions optional",
      async () => {
        assert.equal(manifest.manifest_version, 3);
        assert.deepEqual(manifest.permissions, [
          "storage",
          "activeTab",
          "offscreen",
        ]);
        assert.ok(manifest.optional_permissions.includes("downloads"));
        assert.deepEqual(manifest.content_scripts[0].matches, [
          "https://search.bilibili.com/*",
        ]);
        assert.equal(manifest.host_permissions, undefined);
      },
    );
    await load();
    // Existing checks exercise explicit strict mode; the new default has its own regression fixture.
    await control("mode").selectOption("all");
    await check(
      "nested cards counted once; irrelevant results hidden; unknowns preserved",
      async () => {
        await hiddenCount(2);
        assert.ok(await page.locator("#match").isVisible());
        assert.ok(await page.locator("#unknown").isVisible());
        assert.ok(await page.locator("#nonvideo").isVisible());
        assert.ok(await page.locator("#unsupported").isVisible());
        assert.match(await control("stats").textContent(), /识别 5 个视频/);
        assert.match(
          await control("reasons").textContent(),
          /标题缺少关键词：静音/,
        );
      },
    );
    await check("show hidden and restore filtering", async () => {
      await control("show").click();
      await hiddenCount(0);
      assert.equal(await control("show").getAttribute("aria-pressed"), "true");
      await control("show").click();
      await hiddenCount(2);
    });
    await check("exclusions and relaxed mode keep precedence", async () => {
      await control("exclusions").fill("抽奖");
      await hiddenCount(3);
      await control("mode").selectOption("any");
      await hiddenCount(2);
      assert.ok(await page.locator("#partial").isVisible());
      assert.equal(await page.locator("#excluded").isVisible(), false);
    });
    await check("turning filtering off restores all cards", async () => {
      await control("enabled").uncheck();
      await hiddenCount(0);
      await control("enabled").check();
      await hiddenCount(2);
    });
    await check(
      "disabled filtering ignores resize, focus and native DOM mutations until re-enabled",
      async () => {
        await control("enabled").uncheck();
        await hiddenCount(0);
        await page.waitForTimeout(250);
        const scans = await page.evaluate(() => globalThis.lensCollectCount);
        await page.evaluate(() => {
          window.dispatchEvent(new Event("resize"));
          window.dispatchEvent(new Event("focus"));
          document.querySelector("#partial h3").textContent = "猫猫";
          const added = document.createElement("div");
          added.className = "video-list-item";
          added.id = "disabled-addition";
          added.innerHTML =
            '<a href="https://www.bilibili.com/video/BV1test000099"><h3>猫猫</h3></a>';
          document.querySelector("#results").append(added);
        });
        await page.waitForTimeout(900);
        assert.equal(
          await page.evaluate(() => globalThis.lensCollectCount),
          scans,
        );
        await hiddenCount(0);
        await page.evaluate(() => {
          document.getElementById("disabled-addition").remove();
          document.querySelector("#partial h3").textContent = "机械键盘指南";
        });
        await control("enabled").check();
        await hiddenCount(2);
        assert.ok(
          (await page.evaluate(() => globalThis.lensCollectCount)) > scans,
        );
      },
    );
    await check(
      "invalid rules fail open, correcting them resumes filtering",
      async () => {
        await control("query").fill('"bad');
        await hiddenCount(0);
        assert.match(await control("notice").textContent(), /未闭合/);
        await control("query").fill("机械键盘 静音");
        await hiddenCount(2);
        await control("mode").selectOption("all");
        await hiddenCount(3);
      },
    );
    await check(
      "dynamic additions and reused titles are re-evaluated",
      async () => {
        await page.evaluate(() => {
          const added = document.querySelector("#partial").cloneNode(true);
          added.id = "dynamic";
          document.querySelector("#results").append(added);
        });
        await hiddenCount(4);
        await page.evaluate(
          () =>
            (document.querySelector("#dynamic h3").textContent =
              "机械键盘静音指南"),
        );
        await hiddenCount(3);
        assert.ok(await page.locator("#dynamic").isVisible());
      },
    );
    await check(
      "SPA keyword changes update rules and restore stale hidden markers",
      async () => {
        await page.evaluate(
          (url) => history.pushState({}, "", url),
          base + encodeURIComponent("猫猫"),
        );
        await hiddenCount(4);
        assert.equal(await control("query").inputValue(), "猫猫");
        assert.ok(await page.locator("#irrelevant").isVisible());
        await control("query").fill("猫猫 键盘");
        await control("reset").click();
        assert.equal(await control("query").inputValue(), "猫猫");
      },
    );
    await check(
      "back/forward-cache lifecycle reconnects without forcing a reload",
      async () => {
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          ),
        );
        await hiddenCount(0);
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          ),
        );
        await hiddenCount(4);
        await page.evaluate(
          () =>
            (document.querySelector("#dynamic h3").textContent =
              "猫猫喜欢键盘"),
        );
        await hiddenCount(3);
      },
    );
    await check("titles render as text rather than injected HTML", async () => {
      await page.evaluate(
        () =>
          (document.querySelector("#partial h3").textContent =
            '<img src=x onerror="window.pwned=true">'),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#bili-search-lens")
          .shadowRoot.getElementById("reasons")
          .textContent.includes("<img"),
      );
      assert.equal(await control("reasons").locator("img").count(), 0);
      assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
    });
    await check("settings persist but query text does not", async () => {
      await page.evaluate(() => (globalThis.lensLastSaved = null));
      await control("mode").selectOption("any");
      await page.waitForFunction(
        () => globalThis.lensLastSaved?.biliSearchLensSettings?.mode === "any",
      );
      assert.deepEqual(Object.keys(saved.biliSearchLensSettings).sort(), [
        "enabled",
        "exclusions",
        "expanded",
        "fillPages",
        "mode",
        "relevanceVersion",
        "useVideoTags",
      ]);
      await load("Python");
      assert.equal(await control("query").inputValue(), "Python");
      assert.equal(await control("exclusions").inputValue(), "抽奖");
      assert.equal(await control("mode").inputValue(), "any");
    });
    await check(
      "all hidden results and unrecognized page show useful messages",
      async () => {
        await page.evaluate(() => document.getElementById("unknown").remove());
        await hiddenCount(4);
        await page.waitForFunction(() =>
          document
            .querySelector("#bili-search-lens")
            .shadowRoot.getElementById("notice")
            .textContent.includes("全部已加载视频"),
        );
        assert.match(await control("notice").textContent(), /全部已加载视频/);
        await page.evaluate(() =>
          document.getElementById("results").replaceChildren(),
        );
        await page.waitForFunction(() =>
          document
            .querySelector("#bili-search-lens")
            .shadowRoot.getElementById("notice")
            .textContent.includes("尚未识别"),
        );
        await hiddenCount(0);
      },
    );
    await check(
      "mobile viewport fits the panel and collapse is accessible",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const box = await page.locator("#bili-search-lens").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 390);
        await control("collapse").click();
        assert.equal(
          await control("collapse").getAttribute("aria-expanded"),
          "false",
        );
        assert.equal(await control("body").isVisible(), false);
        await control("collapse").click();
      },
    );
    await check(
      "promotion cards are filtered without exposing tracking links; website-hidden cards stay excluded",
      async () => {
        await page.evaluate(() => {
          const results = document.getElementById("results");
          results.innerHTML =
            '<div class="video-list-item" id="promotion"><a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2?msg=fixture"><h3 class="bili-video-card__info--tit" title="猫猫推广">猫猫<em>推广</em></h3></a></div><div class="video-list-item to_hide_xs" id="site-hidden" style="display:none"><a href="https://www.bilibili.com/video/BV1xx411c7mZ"><h3 class="bili-video-card__info--tit">猫猫</h3></a></div>';
        });
        await hiddenCount(1);
        assert.match(await control("stats").textContent(), /识别 1 个视频/);
        assert.match(
          await control("reasons").textContent(),
          /推广卡片：猫猫推广/,
        );
        assert.equal(await control("reasons").locator("a").count(), 0);
        await control("show").click();
        await hiddenCount(0);
        assert.equal(await page.locator("#site-hidden").isVisible(), false);
        await control("show").click();
        await hiddenCount(1);
        await page.evaluate(() => {
          const title = document.querySelector("#promotion h3");
          title.textContent = "Python推广";
          title.setAttribute("title", "Python推广");
        });
        await hiddenCount(0);
        assert.ok(await page.locator("#promotion").isVisible());
      },
    );
    // Produce a reviewable desktop preview with default rules; test-only local storage.
    Object.keys(saved).forEach((key) => delete saved[key]);
    saved.lensSettingsV2 = {
      version: 2,
      searchExperienceVersion: 1,
      modules: { search: true },
      search: { fillPages: false, useVideoTags: false },
    };
    await page.setViewportSize({ width: 1280, height: 960 });
    await load();
    await control("mode").selectOption("all");
    await control("exclusions").fill("抽奖");
    await hiddenCount(3);
    await control("show").click();
    await hiddenCount(0);
    await page.locator("#bili-search-lens details summary").click();
    fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
    await page.screenshot({
      path: path.join(root, "artifacts", "preview.png"),
      fullPage: true,
    });
    console.log(
      `${passed} browser checks passed; preview saved to artifacts/preview.png`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
