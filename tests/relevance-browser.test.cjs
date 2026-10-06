/* Actual MV3 content scripts on a local Bilibili-shaped fixture, disposable browser profile. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const samples = [
  { id: "compact", title: "GPT6.1 Sol 全面实测" },
  { id: "spaces", title: "GPT 6.1 SOL 发布实测" },
  { id: "dash", title: "GPT-6.1 Sol 前端测试" },
  { id: "short", title: "6.1sol 值得升级吗" },
  { id: "brand", title: "OpenAI新模型来了" },
  { id: "broad", title: "OpenAI dots深度实测：GPT-6 Astra驱动" },
  { id: "unknown", title: "这是我见过最震撼的效果", hide: true },
  {
    id: "description",
    title: "家常红烧肉怎么做",
    description: "用 GPT-6.1 生成菜谱与操作步骤",
  },
  { id: "tags", title: "全新自动化工作流", tags: ["GPT 6.1", "AI"] },
  { id: "giveaway", title: "GPT-6.1 体验与抽奖" },
  { id: "cats", title: "今天又被猫猫叫醒了", hide: true },
  { id: "food", title: "家常红烧肉做法", hide: true },
  { id: "version", title: "GPT5.2 发布评测", hide: true },
  { id: "decimal", title: "GPT6.10 发布实测", hide: true },
];
const escape = (text) =>
  String(text || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:16px sans-serif;background:#f5f8fa;margin:24px}main{max-width:860px}#results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.video-list-item{padding:16px;background:white;border:1px solid #ccdbe3;border-radius:8px}h3{font-size:16px}a{color:#253849}.description,.tag{font-size:12px;color:#5e7280}</style><body><main><h1>搜索 gpt6.1 · 本地回归样例</h1><p>合成标题用于验证相关写法与误删恢复，非真实搜索结果。</p><div id="results">${samples.map((sample, index) => `<div id="${sample.id}" class="video-list-item"><a href="https://www.bilibili.com/video/BV1xx411c${1000 + index}"><h3 class="bili-video-card__info--tit">${escape(sample.title)}</h3></a><p class="description">${escape(sample.description)}</p>${(sample.tags || []).map((tag) => `<span class="tag">${escape(tag)}</span>`).join("")}</div>`).join("")}</div></main></body></html>`;
let checks = 0;
async function check(name, run) {
  await run();
  checks++;
  console.log("PASS " + name);
}
(async () => {
  const profile = fs.mkdtempSync(path.join(artifacts, "relevance-profile-"));
  const source = path.join(root, "extension");
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${source}`,
      `--load-extension=${source}`,
    ],
    viewport: { width: 1366, height: 960 },
  });
  try {
    await context.route("https://search.bilibili.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    );
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const base = worker.url().replace("background.js", "");
    await page.goto(base + "options.html");
    await page.evaluate(() =>
      chrome.storage.local.set({
        lensSettingsV2: {
          version: 2,
          searchExperienceVersion: 1,
          modules: { search: true },
          search: {
            mode: "all",
            exclusions: "",
            expanded: true,
            fillPages: false,
            useVideoTags: false,
          },
        },
      }),
    );
    await page.goto("https://search.bilibili.com/video?keyword=gpt6.1");
    const control = (id) => page.locator("#bili-search-lens #" + id);
    async function hidden(count) {
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-bili-search-lens-hidden="true"]')
            .length === count,
        count,
      );
    }
    await control("stats").waitFor();
    await check(
      "Actual installed extension migrates old strict default to cautious mode",
      async () => {
        await hidden(5);
        assert.equal(await control("mode").inputValue(), "related");
        assert.equal(await control("query-label").textContent(), "搜索主题");
        const stored = await worker.evaluate(() =>
          chrome.storage.local.get("lensSettingsV2"),
        );
        assert.equal(stored.lensSettingsV2.search.relevanceVersion, 1);
        assert.equal(stored.lensSettingsV2.search.mode, "related");
      },
    );
    await check(
      "User-provided spellings, generic OpenAI title remain visible while clue-free titles hide",
      async () => {
        for (const sample of samples)
          assert.equal(
            await page.locator("#" + sample.id).isVisible(),
            !sample.hide,
            sample.title,
          );
        assert.match(await control("stats").textContent(), /关联待确认/);
        assert.match(await control("reasons").textContent(), /不同主题/);
        assert.match(await control("reasons").textContent(), /其他 GPT 版本/);
      },
    );
    await check(
      "Adapter reads existing description and tags as bounded relevance evidence",
      async () => {
        assert.match(
          await page.locator("#description .description").textContent(),
          /GPT-6.1/,
        );
        assert.deepEqual(await page.locator("#tags .tag").allTextContents(), [
          "GPT 6.1",
          "AI",
        ]);
        assert.ok(await page.locator("#description").isVisible());
        assert.ok(await page.locator("#tags").isVisible());
      },
    );
    await check(
      "The user's 6.1sol query keeps full GPT spellings in cautious mode, including screenshot titles",
      async () => {
        await page.evaluate(() =>
          history.pushState({}, "", "/video?keyword=6.1sol"),
        );
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("active-rule")
            .textContent.includes("6.1sol"),
        );
        await hidden(5);
        assert.equal(await control("mode").inputValue(), "related");
        for (const id of [
          "compact",
          "spaces",
          "dash",
          "short",
          "description",
          "tags",
        ])
          assert.equal(await page.locator("#" + id).isVisible(), true, id);
        assert.match(
          await control("active-rule").textContent(),
          /谨慎.*6.1sol/,
        );
        await page
          .locator("#spaces h3")
          .evaluate(
            (node) =>
              (node.textContent = "GPT-6.1 Sol 大战 Opus 5.5：到底该选谁？"),
          );
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#spaces").isVisible(), true);
        assert.equal(await page.locator("#decimal").isVisible(), false);
        await page.evaluate(() =>
          history.pushState({}, "", "/video?keyword=gpt6.1"),
        );
        await page.waitForFunction(() =>
          document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("active-rule")
            .textContent.includes("gpt6.1"),
        );
        await hidden(5);
      },
    );
    await check(
      "Strict mode remains explicit, and switching back restores plausible results",
      async () => {
        await control("mode").selectOption("all");
        await hidden(12);
        assert.equal(await page.locator("#brand").isVisible(), false);
        assert.equal(
          await control("query-label").textContent(),
          "标题必须包含",
        );
        await control("mode").selectOption("related");
        await hidden(5);
        assert.ok(await page.locator("#brand").isVisible());
      },
    );
    await check(
      "User exclusions and temporary release still override cautious evaluation",
      async () => {
        await control("exclusions").fill("抽奖");
        await hidden(6);
        assert.equal(await page.locator("#giveaway").isVisible(), false);
        await control("reason-summary").click();
        await control("reasons")
          .locator("li")
          .filter({ hasText: "GPT5.2" })
          .getByRole("button")
          .click();
        await hidden(5);
        assert.ok(await page.locator("#version").isVisible());
        await control("exclusions").fill("");
        await hidden(4);
      },
    );
    await check(
      "Reused card and late description update reevaluate without stale hiding",
      async () => {
        await page
          .locator("#decimal h3")
          .evaluate((node) => (node.textContent = "GPT 6.1 SOL 新实测"));
        await hidden(3);
        assert.ok(await page.locator("#decimal").isVisible());
        await page
          .locator("#food .description")
          .evaluate((node) => (node.textContent = "使用 GPT-6.1 生成食谱"));
        await hidden(2);
        assert.ok(await page.locator("#food").isVisible());
      },
    );
    await check(
      "Reload keeps cautious choice and turning off restores every card",
      async () => {
        let persisted = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          persisted = await worker.evaluate(async () => {
            const stored = await chrome.storage.local.get("lensSettingsV2");
            return (
              stored.lensSettingsV2.search.mode === "related" &&
              stored.lensSettingsV2.search.exclusions === ""
            );
          });
          if (persisted) break;
          await page.waitForTimeout(100);
        }
        assert.equal(persisted, true);
        await page.reload();
        await control("stats").waitFor();
        await hidden(5);
        assert.equal(await control("mode").inputValue(), "related");
        await control("enabled").uncheck();
        await hidden(0);
        await control("enabled").check();
        await hidden(5);
      },
    );
    await check(
      "Other named model subject is hidden and target comparison evidence restores it",
      async () => {
        await page
          .locator("#unknown h3")
          .evaluate((node) => (node.textContent = "Qwen3.8-Max上线"));
        await hidden(5);
        assert.equal(await page.locator("#unknown").isVisible(), false);
        await page
          .locator("#unknown .description")
          .evaluate((node) => (node.textContent = "对比 GPT-6.1 Sol"));
        await hidden(4);
        assert.equal(await page.locator("#unknown").isVisible(), true);
      },
    );
    await check(
      "Cautious UI has no script errors and fits narrow screens",
      async () => {
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: path.join(artifacts, "search-relevance-preview.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await control("mode").isVisible());
        assert.ok(
          await page
            .locator("#bili-search-lens")
            .evaluate(
              (node) => node.getBoundingClientRect().right <= innerWidth,
            ),
        );
      },
    );
    fs.writeFileSync(
      path.join(artifacts, "search-relevance-report.json"),
      JSON.stringify(
        {
          checks,
          date: new Date().toISOString(),
          fixture: true,
          initial: {
            total: samples.length,
            keep: samples.filter((s) => !s.hide).length,
            hide: 5,
          },
          samples,
        },
        null,
        2,
      ),
    );
    console.log(checks + " actual-extension relevance checks passed");
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
