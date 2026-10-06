/* Loads real MV3 workers and pages in a disposable Edge profile. API data is a fixture. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts"),
  source = path.join(root, "extension");
const executablePath = process.env.TEST_BROWSER_EXECUTABLE;
fs.mkdirSync(artifacts, { recursive: true });
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log("PASS " + name);
}
async function launch(directory) {
  const profile = fs.mkdtempSync(path.join(artifacts, "mv3-profile-")),
    downloads = path.join(profile, "downloads");
  fs.mkdirSync(downloads);
  fs.mkdirSync(path.join(profile, "Default"));
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false },
    }),
  );
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath,
    args: [
      `--disable-extensions-except=${directory}`,
      `--load-extension=${directory}`,
    ],
    acceptDownloads: true,
    downloadsPath: downloads,
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  return { context, worker, base: worker.url().replace("background.js", "") };
}
const fixture = {
  bvid: "BV1UftJ6rE4o",
  aid: 123,
  title: "测试 <script> 视频",
  pic: "https://i0.hdslb.com/bfs/cover.jpg",
  owner: { mid: 123, name: "测试 UP" },
  pages: [
    { cid: 1234, page: 1, part: "第一 P", duration: 20 },
    { cid: 1235, page: 2, part: "第二 P", duration: 20 },
  ],
};
const dmRows = [
  {
    id: "90071992547409931",
    progress: 1000,
    mode: 1,
    fontsize: 25,
    color: 16777215,
    ctime: 1,
    midHash: "s",
    content: "hello",
  },
  {
    id: "2",
    progress: 2000,
    mode: 5,
    fontsize: 25,
    color: 16777215,
    ctime: 1,
    midHash: "s",
    content: "广告",
  },
];
const videoFixture =
  '<!doctype html><html><body><div class="bpx-player-container" tabindex="0"><div class="bpx-player-video-area" style="width:640px;height:360px"><div class="bpx-player-video-wrap"><video style="width:640px;height:360px"></video></div><div class="bpx-player-dm-wrap">原生弹幕</div></div></div><input id="text-input"><div class="recommend-list-v1">推荐</div></body></html>';
async function waitText(page, id, text) {
  await page.waitForFunction(
    ({ id, text }) => document.getElementById(id)?.textContent.includes(text),
    { id, text },
  );
}
(async () => {
  const initial = await launch(source);
  try {
    const p = await initial.context.newPage();
    await p.goto(initial.base + "tools.html");
    await check(
      "actual extension refuses API access before optional permission",
      async () => {
        const result = await p.evaluate(() =>
          chrome.runtime.sendMessage({ op: "view", id: "BV1UftJ6rE4o" }),
        );
        assert.equal(result.ok, false);
        assert.match(result.error, /授权/);
      },
    );
    await check(
      "options save and reject unsupported config versions",
      async () => {
        await p.goto(initial.base + "options.html");
        await p.locator('[data-setting="modules.player"]').check();
        await p.locator('[data-setting="search.blockedTitles"]').fill("测试");
        await p.locator('button[type="submit"]').click();
        await waitText(p, "status", "已保存");
        const stored = await p.evaluate(() =>
          chrome.storage.local.get("lensSettingsV2"),
        );
        assert.equal(stored.lensSettingsV2.modules.player, true);
        await p.locator("#import").setInputFiles({
          name: "invalid.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"version":99}'),
        });
        await waitText(p, "status", "仅支持");
        assert.equal(await p.locator("#confirm-import").isVisible(), false);
      },
    );
  } finally {
    await initial.context.close();
  }
  // Permission-granted test variant uses exactly the production scripts.
  const testDirectory = fs.mkdtempSync(path.join(artifacts, "mv3-extension-"));
  fs.cpSync(source, testDirectory, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(testDirectory, "manifest.json")),
  );
  manifest.permissions.push(...manifest.optional_permissions);
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_permissions;
  delete manifest.optional_host_permissions;
  fs.writeFileSync(
    path.join(testDirectory, "manifest.json"),
    JSON.stringify(manifest),
  );
  const { context, worker, base } = await launch(testDirectory);
  try {
    const errors = [];
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    const tracks = {
      video: [
        {
          key: "video:80:avc1",
          kind: "video",
          extension: "m4s",
          url:
            "data:video/mp4;base64," +
            fs
              .readFileSync(path.join(__dirname, "fixtures/video.m4s"))
              .toString("base64"),
          label: "1080P · avc1",
        },
      ],
      audio: [
        {
          key: "audio:30280:mp4a",
          kind: "audio",
          extension: "m4s",
          url:
            "data:audio/mp4;base64," +
            fs
              .readFileSync(path.join(__dirname, "fixtures/audio.m4s"))
              .toString("base64"),
          label: "192 kbps · mp4a",
        },
      ],
      direct: [],
      duration: 20,
    };
    await worker.evaluate(
      ({ fixture, dmRows, tracks }) => {
        api.view = async () => fixture;
        api.streams = async () => tracks;
        api.segment = async () => dmRows;
        api.player = async () => ({ subtitle: { subtitles: [] } });
        api.search = async () => [
          {
            bvid: fixture.bvid,
            title: "机械键盘指南",
            author: "UP",
            mid: 123,
            play: 100,
          },
        ];
      },
      { fixture, dmRows, tracks },
    );
    const page = await context.newPage();
    await page.goto(base + "tools.html?id=" + fixture.bvid + "&p=2");
    await page.locator("#load").click();
    await waitText(page, "status", "已读取");
    await check(
      "tools load metadata and preserve requested part without HTML injection",
      async () => {
        assert.equal(await page.locator("#page-select").inputValue(), "1235");
        assert.equal(await page.locator("#video-title script").count(), 0);
        assert.match(
          await page.locator("#video-title").textContent(),
          /<script>/,
        );
      },
    );
    await check(
      "DASH tracks stay separate and no fabricated MP3 is offered",
      async () => {
        await page.locator("#get-streams").click();
        await waitText(page, "status", "分轨");
        assert.match(await page.locator("#audio-track").textContent(), /mp4a/);
      },
    );
    await check(
      "real worker runs isolated danmaku filter and shows exact counts",
      async () => {
        await page.locator('[data-tab="danmaku"]').click();
        await page.locator("#danmaku-exclusions").fill("广告");
        await page.locator("#get-danmaku").click();
        await waitText(page, "filter-count", "过滤 1 条");
        assert.match(
          await page.locator("#danmaku-coverage").textContent(),
          /1\/1/,
        );
        await page.locator("#show-rejected").check();
        assert.match(
          await page.locator("#danmaku-list").textContent(),
          /命中关键词/,
        );
      },
    );
    await check(
      "XML roundtrip, large IDs and config rules work in extension origin",
      async () => {
        const roundtrip = await page.evaluate(
          (rows) => LensDanmaku.parseXml(LensDanmaku.xml(rows, 1234)),
          dmRows,
        );
        assert.equal(roundtrip[0].id, "90071992547409931");
        assert.equal(roundtrip.length, 2);
      },
    );
    await check(
      "invalid regex does not export an unfiltered success",
      async () => {
        await page.locator("#danmaku-regex").fill("[");
        await page.locator("#apply-filter").click();
        await waitText(page, "status", "无效");
        await page.locator("#danmaku-regex").fill("");
      },
    );
    await check(
      "local import data is previewed and XML export creates a real file",
      async () => {
        await page.locator("#import-danmaku").setInputFiles({
          name: "test.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(dmRows)),
        });
        await waitText(page, "status", "已导入");
        const downloaded = page.waitForEvent("download");
        await page.locator("#export-danmaku").click();
        const download = await downloaded;
        const file = await download.path();
        assert.ok(fs.readFileSync(file, "utf8").includes("hello"));
      },
    );
    await check(
      "bounded search merges duplicates from three requested sort orders",
      async () => {
        await page.locator('[data-tab="search"]').click();
        await page.locator("#search-keyword").fill("机械键盘");
        await page.locator("#search-multiple").check();
        await page.locator("#run-search").click();
        await waitText(page, "search-count", "已请求 3 页");
        assert.equal(await page.locator("#search-results a").count(), 1);
      },
    );
    await check(
      "batch danmaku ZIP includes selected parts and coverage",
      async () => {
        await page.locator('[data-tab="danmaku"]').click();
        await page.getByText("分 P 弹幕批量导出", { exact: true }).click();
        await page.locator("#prepare-dm-batch").click();
        await page.locator("#dm-batch-pages input").first().check();
        await page.locator("#dm-batch-pages input").last().check();
        await page.locator("#export-source").selectOption("raw");
        await page.locator("#danmaku-format").selectOption("json");
        const promise = page.waitForEvent("download");
        await page.locator("#batch-danmaku").click();
        const download = await promise;
        const bytes = fs.readFileSync(await download.path());
        assert.equal(bytes.readUInt32LE(0), 0x04034b50);
        assert.ok(
          bytes.includes(Buffer.from("P01-")) &&
            bytes.includes(Buffer.from("P02-")),
        );
        assert.ok(bytes.includes(Buffer.from("loadedSegments")));
      },
    );
    await check(
      "bookmarks retain part identity and can be deleted",
      async () => {
        await page.locator('[data-tab="subtitles"]').click();
        await page.locator("#bookmark-time").fill("5");
        await page.locator("#bookmark-note").fill("第二 P 笔记");
        await page.locator("#save-bookmark").click();
        await waitText(page, "status", "书签已保存");
        const settings = await page.evaluate(() => LensSettings.load());
        assert.equal(settings.bookmarks.at(-1).cid, 1235);
        assert.equal(settings.bookmarks.at(-1).page, 2);
        await page
          .locator("#bookmark-list")
          .getByText("删除", { exact: true })
          .click();
        await page.waitForFunction(
          () =>
            !document
              .getElementById("bookmark-list")
              .textContent.includes("第二 P 笔记"),
        );
      },
    );
    await check(
      "pathological regex is terminated while raw export remains available",
      async () => {
        await page.locator('[data-tab="danmaku"]').click();
        await page.locator("#danmaku-regex").fill("(a+)+$");
        await page.locator("#import-danmaku").setInputFiles({
          name: "slow.json",
          mimeType: "application/json",
          buffer: Buffer.from(
            JSON.stringify([{ ...dmRows[0], content: "a".repeat(2000) + "!" }]),
          ),
        });
        await waitText(page, "status", "超过 3 秒");
        await page.locator("#export-source").selectOption("raw");
        await page.locator("#danmaku-format").selectOption("json");
        const promise = page.waitForEvent("download");
        await page.locator("#export-danmaku").click();
        const download = await promise;
        assert.equal(
          JSON.parse(fs.readFileSync(await download.path(), "utf8")).rows
            .length,
          1,
        );
        await page.locator("#danmaku-regex").fill("");
      },
    );
    await check(
      "late danmaku response cannot populate a newly selected part",
      async () => {
        await worker.evaluate(async () => {
          await LensCache.clear();
          api.segment = async () =>
            new Promise((resolve) => {
              globalThis.fixtureSegmentResolve = resolve;
            });
        });
        await page.locator("#get-danmaku").click();
        await waitText(page, "status", "正在获取");
        let started = false;
        for (let i = 0; i < 50; i++) {
          started = await worker.evaluate(
            () => typeof globalThis.fixtureSegmentResolve === "function",
          );
          if (started) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(started, true);
        await page.locator("#page-select").selectOption("1234");
        await worker.evaluate((rows) => {
          globalThis.fixtureSegmentResolve(rows);
          api.segment = async () => rows;
        }, dmRows);
        await page.waitForFunction(
          () => !document.getElementById("get-danmaku").disabled,
        );
        assert.equal(await page.evaluate(() => rows.length), 0);
        await page.locator("#page-select").selectOption("1235");
      },
    );
    await check(
      "site injection restores player rate and section visibility when disabled",
      async () => {
        const settings = await page.evaluate(() => LensSettings.load());
        settings.modules.player = true;
        settings.player.rate = 1.5;
        settings.hiddenSections = ["related"];
        await page.evaluate((value) => LensSettings.save(value), settings);
        await context.route("https://www.bilibili.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: videoFixture }),
        );
        const site = await context.newPage();
        await site.goto("https://www.bilibili.com/video/" + fixture.bvid + "/");
        await site.locator("#bili-lens-video-tools").waitFor();
        await site
          .getByRole("button", { name: "展开视频工具", exact: true })
          .click();
        await site.waitForFunction(
          () => document.querySelector("video").playbackRate === 1.5,
        );
        assert.equal(
          await site.locator(".recommend-list-v1").isVisible(),
          false,
        );
        await site
          .locator("#bili-lens-video-tools button")
          .getByText("启用过滤弹幕（实验）")
          .click();
        await site.locator("[data-lens-overlay]").waitFor();
        assert.equal(
          await site
            .locator(".bpx-player-dm-wrap")
            .evaluate((el) => el.style.visibility),
          "hidden",
        );
        settings.modules.player = false;
        await page.evaluate((value) => LensSettings.save(value), settings);
        await site.waitForFunction(
          () => document.querySelector("video").playbackRate === 1,
        );
        assert.equal(await site.locator("[data-lens-overlay]").count(), 0);
        assert.equal(
          await site.locator(".recommend-list-v1").isVisible(),
          true,
        );
        assert.equal(
          await site
            .locator(".bpx-player-dm-wrap")
            .evaluate((el) => el.style.visibility),
          "",
        );
        const attack = await worker.evaluate(async () => {
          try {
            await handle(
              {
                op: "enqueue",
                bvid: "BV1UftJ6rE4o",
                cid: 1234,
                keys: ["video:80:avc1"],
              },
              {
                id: chrome.runtime.id,
                url: "https://www.bilibili.com/video/BV1UftJ6rE4o/",
              },
            );
            return "accepted";
          } catch (e) {
            return e.message;
          }
        });
        assert.match(attack, /仅能/);
      },
    );
    await check(
      "real browser saves both fixture files and persists completion without URLs",
      async () => {
        const result = await page.evaluate(() =>
          chrome.runtime.sendMessage({
            op: "enqueue",
            bvid: "BV1UftJ6rE4o",
            cid: 1235,
            keys: ["video:80:avc1", "audio:30280:mp4a"],
          }),
        );
        assert.equal(result.ok, true);
        let response;
        for (let i = 0; i < 50; i++) {
          response = await page.evaluate(() =>
            chrome.runtime.sendMessage({ op: "tasks" }),
          );
          if (
            response.result.length === 2 &&
            response.result.every(
              (t) => t.state === "saved" || t.state === "failed",
            )
          )
            break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.deepEqual(
          response.result.map((t) => t.state),
          ["saved", "saved"],
        );
        const saved = await page.evaluate(() =>
          chrome.storage.local.get("lensDownloadTasks"),
        );
        assert.equal(saved.lensDownloadTasks.length, 2);
        assert.ok(saved.lensDownloadTasks.every((t) => !t.url));
        for (const task of saved.lensDownloadTasks) {
          assert.ok(
            path.resolve(task.filename).startsWith(artifacts + path.sep),
          );
          assert.deepEqual(
            fs.readFileSync(task.filename),
            fs.readFileSync(
              path.join(__dirname, "fixtures", `${task.kind}.m4s`),
            ),
          );
        }
      },
    );
    await check(
      "resolving download can be aborted before a file is created",
      async () => {
        await worker.evaluate(async () => {
          resourceCache.clear();
          api.streams = async (bvid, cid, qn, { signal }) =>
            new Promise((resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error("请求已取消")),
                { once: true },
              ),
            );
          const all = await getTasks();
          all.push({
            id: "abort-fixture",
            bvid: "BV1UftJ6rE4o",
            cid: 1234,
            kind: "video",
            trackKey: "video:80:avc1",
            relativeFilename: "abort.m4s",
            state: "queued",
            createdAt: Date.now(),
          });
          await saveTasks(all);
        });
        await page.evaluate(() => {
          chrome.runtime.sendMessage({ op: "tasks" });
        });
        let resolving = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          resolving = await worker.evaluate(() =>
            taskResolvers.has("abort-fixture"),
          );
          if (resolving) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(resolving, true);
        const result = await page.evaluate(() =>
          chrome.runtime.sendMessage({
            op: "taskAction",
            taskId: "abort-fixture",
            action: "cancel",
          }),
        );
        assert.equal(result.ok, true);
        assert.equal(
          result.result.find((t) => t.id === "abort-fixture").state,
          "cancelled",
        );
        assert.equal(
          result.result.find((t) => t.id === "abort-fixture").downloadId,
          undefined,
        );
      },
    );
    await check(
      "worker restart reconciles persisted downloads and interrupted parsing",
      async () => {
        await worker.evaluate(async () => {
          const all = await getTasks();
          all.push({
            id: "interrupted-fixture",
            state: "resolving",
            kind: "audio",
            createdAt: Date.now(),
          });
          await saveTasks(all);
        });
        const session = await context.newCDPSession(page);
        await session.send("ServiceWorker.enable");
        await session.send("ServiceWorker.stopAllWorkers");
        const reply = await page.evaluate(() =>
          chrome.runtime.sendMessage({ op: "tasks" }),
        );
        assert.equal(reply.ok, true);
        assert.equal(
          reply.result.find((t) => t.id === "interrupted-fixture").state,
          "failed",
        );
        assert.match(
          reply.result.find((t) => t.id === "interrupted-fixture").error,
          /中断/,
        );
        assert.equal(reply.result.filter((t) => t.state === "saved").length, 2);
        await session.detach();
      },
    );
    await check(
      "no runtime errors, narrow view and reproducible preview",
      async () => {
        assert.deepEqual(errors, []);
        await page.locator('[data-tab="danmaku"]').click();
        await page.screenshot({
          path: path.join(artifacts, "tools-preview.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        );
      },
    );
    console.log(`${checks} actual-extension checks passed`);
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
