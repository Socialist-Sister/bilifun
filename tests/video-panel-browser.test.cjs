/* Actual MV3 inline tools iframe, disposable Edge profile and synthetic media.
 * API fixtures only; no user account, real Bilibili requests or native helper. */
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
const bvid = "BV1UftJ6rE4o",
  nextId = "BV1test000002";
const fixture =
  '<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#f4f7fa}.bpx-player-container{width:640px;height:360px;background:#162433}.bpx-state-web{position:fixed;inset:0;width:100vw;height:100vh;z-index:200}video{width:100%;height:100%}</style><div class="bpx-player-container"><div class="bpx-player-video-area"><div class="bpx-player-video-wrap"><video></video></div><div class="bpx-player-dm-wrap"></div></div></div><h1>测试视频</h1><button id="fullscreen">播放器全屏</button><script>document.getElementById("fullscreen").onclick=()=>document.documentElement.requestFullscreen()</script>';
async function waitStatus(frame, text) {
  try {
    await frame.locator("#status").filter({ hasText: text }).waitFor();
  } catch (error) {
    console.error(
      "Panel status:",
      await frame.locator("#status").textContent(),
    );
    throw error;
  }
}
(async () => {
  const source = fs.mkdtempSync(path.join(artifacts, "panel-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "manifest.json")),
  );
  manifest.permissions.push("downloads", "declarativeNetRequestWithHostAccess");
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (p) => !manifest.permissions.includes(p),
  );
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify(manifest),
  );
  const profile = fs.mkdtempSync(path.join(artifacts, "panel-profile-")),
    downloads = path.join(profile, "downloads");
  fs.mkdirSync(downloads);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${source}`,
      `--load-extension=${source}`,
    ],
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    downloadsPath: downloads,
  });
  const errors = [];
  context.on("page", (p) =>
    p.on("pageerror", (error) => errors.push(error.message)),
  );
  try {
    await check(
      "Only tools.html is exposed to the Bilibili origin; no mandatory capability was added",
      async () => {
        const production = JSON.parse(
          fs.readFileSync(path.join(root, "extension/manifest.json")),
        );
        assert.deepEqual(production.permissions, [
          "storage",
          "activeTab",
          "offscreen",
        ]);
        assert.deepEqual(production.web_accessible_resources, [
          {
            resources: ["tools.html"],
            matches: ["https://www.bilibili.com/*"],
          },
        ]);
      },
    );
    await context.route("https://www.bilibili.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    );
    await context.route("https://**/*", (route) =>
      new URL(route.request().url()).hostname === "www.bilibili.com"
        ? route.fallback()
        : route.abort(),
    );
    await context.route("https://i0.hdslb.com/panel-cover.png", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="224" height="144"><rect width="224" height="144" fill="#d8edf4"/><path d="M0 130 75 40 127 92 178 32 224 105V144H0" fill="#81aebe"/><text x="16" y="126" font-size="20" fill="white">基建教学</text></svg>',
      }),
    );
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
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
      ({ bvid, tracks }) => {
        globalThis.panelQA = {
          views: [],
          streamCalls: [],
          playerCalls: [],
          segmentCalls: 0,
          streamFail: false,
          playerHang: false,
          playerAborted: false,
          streamLate: false,
          started: false,
          aborted: false,
          hang: false,
        };
        api.view = async (id, { signal } = {}) => {
          panelQA.views.push(id);
          if (panelQA.hang) {
            panelQA.started = true;
            await new Promise((resolve, reject) => {
              globalThis.panelRelease = resolve;
              signal.addEventListener(
                "abort",
                () => {
                  panelQA.aborted = true;
                  reject(new DOMException("取消", "AbortError"));
                },
                { once: true },
              );
            });
          }
          return {
            bvid: id,
            title: "终末地基建教学 · 内嵌测试视频",
            pic: "https://i0.hdslb.com/panel-cover.png",
            owner: { mid: 123, name: "测试 UP" },
            pages: [
              { cid: 1234, page: 1, part: "第一 P", duration: 20 },
              { cid: 1235, page: 2, part: "第二 P", duration: 20 },
            ],
          };
        };
        api.streams = async (id, cid, quality, { signal } = {}) => {
          panelQA.streamCalls.push(cid);
          if (panelQA.streamFail) throw new Error("轨道测试失败");
          if (panelQA.streamLate) {
            panelQA.streamLate = false;
            await new Promise((resolve) => {
              globalThis.releaseStream = resolve;
            });
            return {
              ...tracks,
              video: [
                { ...tracks.video[0], key: "video:stale", label: "过期轨道" },
              ],
            };
          }
          return tracks;
        };
        api.segment = async () => {
          panelQA.segmentCalls++;
          return [
            {
              id: "1",
              progress: 1000,
              mode: 1,
              fontsize: 25,
              color: 16777215,
              ctime: 1,
              midHash: "a",
              content: "保留弹幕",
            },
            {
              id: "2",
              progress: 2000,
              mode: 1,
              fontsize: 25,
              color: 16777215,
              ctime: 1,
              midHash: "b",
              content: "广告弹幕",
            },
          ];
        };
        api.player = async (id, cid, { signal } = {}) => {
          panelQA.playerCalls.push(cid);
          if (panelQA.playerHang)
            await new Promise((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  panelQA.playerAborted = true;
                  reject(new DOMException("取消", "AbortError"));
                },
                { once: true },
              );
            });
          return {
            subtitle: {
              subtitles: [
                {
                  lan: "zh-CN",
                  lan_doc: "中文",
                  subtitle_url: "https://i0.hdslb.com/test-subtitle.json",
                },
              ],
            },
          };
        };
        api.subtitle = async () => ({
          body: [{ from: 1, to: 2, content: "字幕内容" }],
        });
      },
      { bvid, tracks },
    );
    const site = await context.newPage();
    await site.goto(`https://www.bilibili.com/video/${bvid}/?p=2`);
    const ball = () =>
      site.getByRole("button", { name: "展开视频工具", exact: true });
    let frame;
    async function open() {
      await ball().click();
      await site.locator("#bili-lens-video-tools iframe").waitFor();
      const handle = await site
        .locator("#bili-lens-video-tools iframe")
        .elementHandle();
      frame = await handle.contentFrame();
      await frame.waitForFunction(
        () =>
          document.getElementById("load") &&
          !document.getElementById("load").disabled,
      );
      await site.locator("#lens-video-drawer").evaluate(async (el) => {
        await Promise.all(
          el
            .getAnimations({ subtree: true })
            .map((a) => a.finished.catch(() => {})),
        );
      });
    }
    await check(
      "Collapsed launcher is 48px, mounts no iframe and opens no new tab",
      async () => {
        await ball().waitFor();
        const box = await ball().boundingBox();
        assert.equal(box.width, 48);
        assert.equal(box.height, 48);
        assert.equal(
          await site.locator("#bili-lens-video-tools iframe").count(),
          0,
        );
        assert.equal((await worker.evaluate(() => panelQA.views)).length, 0);
      },
    );
    const tabs = context.pages().length,
      originalUrl = site.url();
    await check(
      "Tools load inline at extension origin, carry current BV/P and automatically read after prior authorization",
      async () => {
        await open();
        assert.equal(context.pages().length, tabs);
        assert.equal(site.url(), originalUrl);
        assert.ok(
          frame
            .url()
            .startsWith(worker.url().replace("background.js", "tools.html")),
        );
        assert.equal(new URL(frame.url()).searchParams.get("p"), "2");
        assert.equal(await frame.locator("#video-input").inputValue(), bvid);
        assert.equal(await frame.locator("header").isVisible(), false);
        assert.equal(
          await frame.locator('[data-tab="search"]').isVisible(),
          false,
        );
        await waitStatus(frame, "已就绪");
        assert.equal((await worker.evaluate(() => panelQA.views)).length, 1);
        assert.equal(await worker.evaluate(() => panelQA.segmentCalls), 0);
        assert.equal(
          (await worker.evaluate(() => chrome.downloads.search({}))).length,
          0,
        );
      },
    );
    await check(
      "Metadata and media tracks are read and selected entirely in the drawer",
      async () => {
        await waitStatus(frame, "已就绪");
        assert.equal(await frame.locator("#page-select").inputValue(), "1235");
        assert.deepEqual(
          await worker.evaluate(() => panelQA.streamCalls),
          [1235],
        );
        assert.deepEqual(
          await worker.evaluate(() => panelQA.playerCalls),
          [1235],
        );
        assert.equal(
          await frame.locator("#video-track").inputValue(),
          tracks.video[0].key,
        );
        assert.equal(
          await frame.locator("#audio-track").inputValue(),
          tracks.audio[0].key,
        );
      },
    );
    await check(
      "Drawer refresh re-requests current resources despite a recent partial cache and advertises plugin-only MP4",
      async () => {
        const before = await worker.evaluate(() => panelQA.streamCalls.length);
        await worker.evaluate(() =>
          resourceCache.set(`${panelQA.views[0]}:1235`, {
            time: Date.now(),
            value: { video: [], audio: [], direct: [], duration: 20 },
          }),
        );
        await frame.locator("#load").click();
        await waitStatus(frame, "已就绪");
        assert.equal(
          await worker.evaluate(() => panelQA.streamCalls.length),
          before + 1,
        );
        assert.equal(
          await frame.locator("#video-track").inputValue(),
          tracks.video[0].key,
        );
        assert.equal(
          await frame.locator("#audio-track").inputValue(),
          tracks.audio[0].key,
        );
        assert.doesNotMatch(
          await frame.locator("#media").textContent(),
          /合并为一个文件需本地助手/,
        );
      },
    );
    await check(
      "Embedded video/audio download buttons save both fixture files through the real worker",
      async () => {
        await frame.locator("#media-advanced > summary").click();
        await frame.locator("#download-both").click();
        await waitStatus(frame, "任务已加入");
        await worker.evaluate(async () => {
          await chrome.storage.local.get("lensDownloadTasks");
        });
        for (let i = 0; i < 80; i++) {
          const result = await worker.evaluate(
            async () =>
              (await chrome.storage.local.get("lensDownloadTasks"))
                .lensDownloadTasks || [],
          );
          if (
            result.length === 2 &&
            result.every((t) => ["saved", "failed"].includes(t.state))
          )
            break;
          await site.waitForTimeout(100);
        }
        const tasks = await worker.evaluate(
          async () =>
            (await chrome.storage.local.get("lensDownloadTasks"))
              .lensDownloadTasks,
        );
        assert.deepEqual(
          tasks.map((t) => t.state),
          ["saved", "saved"],
        );
        const downloadsApi = await worker.evaluate(() =>
          chrome.downloads.search({}),
        );
        for (const t of downloadsApi) {
          const task = tasks.find((task) => task.downloadId === t.id);
          assert.ok(task);
          const expected = fs.readFileSync(
            path.join(
              __dirname,
              "fixtures",
              task.kind === "video" ? "video.m4s" : "audio.m4s",
            ),
          );
          assert.ok(
            fs.readFileSync(t.filename).equals(expected),
            `${task.kind} fixture bytes must match`,
          );
        }
        assert.equal(site.url(), originalUrl);
        // Edge exposes its native downloads flyout as a Page. The extension
        // must not open a tools tab; the browser's own download indicator is OK.
        assert.equal(
          context.pages().filter((p) => !/^(edge|chrome):\/\//.test(p.url()))
            .length,
          tabs,
        );
      },
    );
    await check(
      "Danmaku can be read, filtered and exported from the embedded tab",
      async () => {
        await frame.locator('[data-tab="danmaku"]').click();
        await frame.locator("#danmaku-exclusions").fill("广告");
        await frame.locator("#get-danmaku").click();
        await waitStatus(frame, "弹幕获取结束");
        assert.match(
          await frame.locator("#filter-count").textContent(),
          /保留 1/,
        );
        await frame.locator("#danmaku-format").selectOption("xml");
        const exported = frame.page().waitForEvent("download");
        await frame.locator("#export-danmaku").click();
        const file = await exported;
        const text = fs.readFileSync(await file.path(), "utf8");
        assert.match(text, /保留弹幕/);
        assert.doesNotMatch(text, /广告弹幕/);
      },
    );
    await check(
      "Subtitle tracks and a real SRT export work without navigating away",
      async () => {
        await frame.locator('[data-tab="subtitles"]').click();
        assert.equal(await frame.locator("#subtitle-track").inputValue(), "0");
        await frame.locator("#subtitle-format").selectOption("srt");
        const exported = site.waitForEvent("download");
        await frame.locator("#export-subtitle").click();
        const file = await exported;
        assert.match(fs.readFileSync(await file.path(), "utf8"), /字幕内容/);
        assert.equal(site.url(), originalUrl);
      },
    );
    await check(
      "Escape in iframe collapses the drawer; reopening preserves selected tools and metadata",
      async () => {
        await frame.locator("#subtitle-format").focus();
        await site.keyboard.press("Escape");
        await ball().waitFor();
        assert.equal(
          await site.locator("#lens-video-drawer").isVisible(),
          false,
        );
        const calls = await worker.evaluate(() => panelQA.views.length);
        await open();
        assert.equal(await worker.evaluate(() => panelQA.views.length), calls);
        assert.equal(await frame.locator("#page-select").inputValue(), "1235");
        assert.equal(await frame.locator("#subtitles").isVisible(), true);
      },
    );
    await check(
      "Website messages cannot command embedded tools or forge a collapse from the frame",
      async () => {
        const prior = await worker.evaluate(
          async () =>
            (await chrome.storage.local.get("lensDownloadTasks"))
              .lensDownloadTasks.length,
        );
        await site.evaluate(() => {
          window.postMessage({ type: "lens-tools-collapse" }, "*");
          document
            .getElementById("bili-lens-video-tools")
            .shadowRoot.querySelector("iframe")
            .contentWindow.postMessage(
              { op: "enqueue", bvid: "BV1test000002", keys: ["x"] },
              "*",
            );
        });
        await site.waitForTimeout(150);
        assert.equal(
          await site.locator("#lens-video-drawer").isVisible(),
          true,
        );
        assert.equal(
          await worker.evaluate(
            async () =>
              (await chrome.storage.local.get("lensDownloadTasks"))
                .lensDownloadTasks.length,
          ),
          prior,
        );
      },
    );
    await check(
      "Web-fullscreen hides ball and open drawer; exiting returns to a collapsed launcher",
      async () => {
        await site
          .locator(".bpx-player-container")
          .evaluate((el) => el.classList.add("bpx-state-web"));
        await site.waitForFunction(
          () => document.getElementById("bili-lens-video-tools").hidden,
        );
        assert.equal(
          await site.locator("#bili-lens-video-tools").isVisible(),
          false,
        );
        await site
          .locator(".bpx-player-container")
          .evaluate((el) => el.classList.remove("bpx-state-web"));
        await ball().waitFor();
        assert.equal(
          await site.locator("#lens-video-drawer").isVisible(),
          false,
        );
      },
    );
    await check(
      "The actual Fullscreen API hides the host even when the whole document is fullscreen",
      async () => {
        await open();
        await site.locator("#fullscreen").click();
        await site.waitForFunction(() => !!document.fullscreenElement);
        await site.waitForFunction(
          () => document.getElementById("bili-lens-video-tools").hidden,
        );
        assert.equal(
          await site.locator("#bili-lens-video-tools").isVisible(),
          false,
        );
        await site.evaluate(() => document.exitFullscreen());
        await ball().waitFor();
      },
    );
    await check(
      "390px drawer fits horizontally and desktop/mobile screenshots are reproducible",
      async () => {
        await open();
        await frame.locator('[data-tab="media"]').click();
        assert.equal(await frame.locator("#media").isVisible(), true);
        await frame.locator("#load").click();
        await waitStatus(frame, "已就绪");
        await frame
          .locator("#media-advanced > summary")
          .evaluate((el) => (el.parentElement.open = false));
        await frame.evaluate(() => window.scrollTo(0, 0));
        await site.waitForTimeout(300); // Capture the settled design, after its 220ms entry animation.
        await site.screenshot({
          path: path.join(artifacts, "video-panel-1440.png"),
        });
        await site.setViewportSize({ width: 390, height: 844 });
        const rect = await site.locator("#lens-video-drawer").boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= 390);
        assert.ok(rect.y >= 0);
        assert.equal(
          await frame.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await site.screenshot({
          path: path.join(artifacts, "video-panel-390.png"),
        });
        await site.setViewportSize({ width: 1440, height: 1000 });
      },
    );
    await check(
      "Keyboard tabs and reduced-motion setting work in the inline panel",
      async () => {
        await frame.locator('[data-tab="media"]').focus();
        await site.keyboard.press("ArrowRight");
        assert.equal(
          await frame
            .locator('[data-tab="danmaku"]')
            .getAttribute("aria-selected"),
          "true",
        );
        await site.keyboard.press("Home");
        assert.equal(
          await frame
            .locator('[data-tab="media"]')
            .getAttribute("aria-selected"),
          "true",
        );
        await site.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(
          await frame
            .locator("#media")
            .evaluate((el) => getComputedStyle(el).animationName),
          "none",
        );
        assert.equal(
          await site
            .locator("#lens-video-drawer")
            .evaluate((el) => getComputedStyle(el).animationName),
          "none",
        );
        await site.emulateMedia({ reducedMotion: "no-preference" });
      },
    );
    await check(
      "Changing part automatically reloads resources without reloading metadata; refresh preserves the part",
      async () => {
        const count = await worker.evaluate(() => panelQA.views.length);
        await frame.locator("#page-select").selectOption("1234");
        await waitStatus(frame, "已就绪");
        assert.equal(await worker.evaluate(() => panelQA.views.length), count);
        assert.equal(
          await worker.evaluate(() => panelQA.playerCalls.at(-1)),
          1234,
        );
        await frame.locator("#load").click();
        await waitStatus(frame, "已就绪");
        assert.equal(await frame.locator("#page-select").inputValue(), "1234");
      },
    );
    await check(
      "Track failures preserve video metadata and subtitles and can be retried",
      async () => {
        await worker.evaluate(() => {
          resourceCache.clear();
          panelQA.streamFail = true;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "视频信息已保留");
        assert.equal(
          await frame.locator("#auto-state").textContent(),
          "部分读取失败",
        );
        assert.match(
          await frame.locator("#video-title").textContent(),
          /基建教学/,
        );
        assert.equal(await frame.locator("#subtitle-track").inputValue(), "0");
        await worker.evaluate(() => {
          panelQA.streamFail = false;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "已就绪");
      },
    );
    await check(
      "Stopping a pending subtitle-list request cancels the actual worker operation",
      async () => {
        await worker.evaluate(() => {
          panelQA.playerHang = true;
          panelQA.playerAborted = false;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "正在读取字幕列表");
        await frame.locator("#cancel-read").click();
        await waitStatus(frame, "已停止读取字幕列表");
        for (let i = 0; i < 50; i++) {
          if (await worker.evaluate(() => panelQA.playerAborted)) break;
          await site.waitForTimeout(50);
        }
        assert.equal(await worker.evaluate(() => panelQA.playerAborted), true);
        assert.equal(
          await frame.locator("#auto-state").textContent(),
          "读取已暂停",
        );
        await worker.evaluate(() => {
          panelQA.playerHang = false;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "已就绪");
      },
    );
    await check(
      "A subtitle-list deadline ends the loading state and cancels its worker request (accelerated 25s clock)",
      async () => {
        await worker.evaluate(() => {
          panelQA.playerHang = true;
          panelQA.playerAborted = false;
        });
        await frame.evaluate(() => {
          globalThis.originalPanelTimeout = setTimeout;
          globalThis.setTimeout = (fn, ms, ...args) =>
            originalPanelTimeout(fn, ms === 25000 ? 150 : ms, ...args);
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "读取超过 25 秒");
        assert.equal(
          await frame.locator("#auto-state").textContent(),
          "部分读取失败",
        );
        assert.equal(await frame.locator("#cancel-read").isDisabled(), true);
        for (let i = 0; i < 50; i++) {
          if (await worker.evaluate(() => panelQA.playerAborted)) break;
          await site.waitForTimeout(50);
        }
        assert.equal(await worker.evaluate(() => panelQA.playerAborted), true);
        await frame.evaluate(() => {
          globalThis.setTimeout = originalPanelTimeout;
        });
        await worker.evaluate(() => {
          panelQA.playerHang = false;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "已就绪");
      },
    );
    await check(
      "A late old-part track response cannot overwrite the new part or poison its cache",
      async () => {
        await worker.evaluate(() => {
          resourceCache.clear();
          panelQA.streamLate = true;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "正在读取可用媒体轨道");
        for (let i = 0; i < 50; i++) {
          if (await worker.evaluate(() => typeof releaseStream === "function"))
            break;
          await site.waitForTimeout(50);
        }
        await frame.locator("#page-select").selectOption("1235");
        await waitStatus(frame, "已就绪");
        await worker.evaluate(() => releaseStream());
        await site.waitForTimeout(100);
        assert.equal(await frame.locator("#page-select").inputValue(), "1235");
        assert.equal(
          await frame.locator("#video-track").inputValue(),
          tracks.video[0].key,
        );
        assert.equal(
          await worker.evaluate(() =>
            resourceCache.has(`${panelQA.views[0]}:1234`),
          ),
          false,
        );
        await frame.locator("#page-select").selectOption("1234");
        await waitStatus(frame, "已就绪");
        assert.equal(
          await frame.locator("#video-track").inputValue(),
          tracks.video[0].key,
        );
      },
    );
    await check(
      "Unapproved API access stays idle; an explicit grant starts automatic reading (permission UI fixture)",
      async () => {
        const missing = await context.newPage();
        await missing.addInitScript(() => {
          const original = chrome.permissions.contains.bind(chrome.permissions);
          globalThis.permissionQA = { granted: false, requests: 0 };
          chrome.permissions.contains = async (p) =>
            p.origins?.includes("https://api.bilibili.com/*")
              ? permissionQA.granted
              : original(p);
          chrome.permissions.request = async () => {
            permissionQA.requests++;
            permissionQA.granted = true;
            return true;
          };
        });
        const count = await worker.evaluate(() => panelQA.views.length);
        await missing.goto(
          worker
            .url()
            .replace("background.js", `tools.html?embed=1&id=${bvid}&p=2`),
        );
        await waitStatus(missing, "首次使用需授权");
        assert.equal(await missing.evaluate(() => permissionQA.requests), 0);
        assert.equal(await worker.evaluate(() => panelQA.views.length), count);
        await missing
          .getByRole("button", { name: "授权并读取", exact: true })
          .click();
        await waitStatus(missing, "已就绪");
        assert.equal(await missing.evaluate(() => permissionQA.requests), 1);
        assert.equal(
          await missing.locator("#page-select").inputValue(),
          "1235",
        );
        await missing.close();
      },
    );
    await check(
      "SPA changes cancel old metadata, remove the old frame and bind the next BV/P",
      async () => {
        await worker.evaluate(() => {
          panelQA.hang = true;
          panelQA.started = false;
        });
        await frame.locator("#load").click();
        await waitStatus(frame, "正在读取视频信息");
        await site.evaluate(
          (nextId) => history.pushState({}, "", `/video/${nextId}/?p=1`),
          nextId,
        );
        await site.waitForFunction(
          () =>
            document
              .getElementById("bili-lens-video-tools")
              ?.shadowRoot.querySelector(".ball")
              ?.getAttribute("aria-expanded") === "false",
        );
        for (let i = 0; i < 50; i++) {
          if (await worker.evaluate(() => panelQA.aborted)) break;
          await site.waitForTimeout(100);
        }
        assert.equal(await worker.evaluate(() => panelQA.aborted), true);
        await worker.evaluate(() => {
          panelQA.hang = false;
        });
        await open();
        assert.equal(await frame.locator("#video-input").inputValue(), nextId);
        assert.equal(new URL(frame.url()).searchParams.get("p"), "1");
        await waitStatus(frame, "已就绪");
        assert.equal(await frame.locator("#page-select").inputValue(), "1234");
      },
    );
    const dragPage = await context.newPage();
    await dragPage.goto(`https://www.bilibili.com/video/${bvid}/`);
    const dragBall = dragPage.locator("#bili-lens-video-tools .ball");
    await dragBall.waitFor();
    let draggedBox;
    await check(
      "Dragging moves the launcher without opening the drawer; Escape cancels an in-progress drag",
      async () => {
        const start = await dragBall.boundingBox();
        await dragPage.mouse.move(start.x + 24, start.y + 24);
        await dragPage.mouse.down();
        await dragPage.mouse.move(160, 170, { steps: 8 });
        await dragPage.keyboard.press("Escape");
        await dragPage.mouse.up();
        const cancelled = await dragBall.boundingBox();
        assert.ok(
          Math.abs(cancelled.x - start.x) < 1 &&
            Math.abs(cancelled.y - start.y) < 1,
        );
        await dragPage.mouse.move(start.x + 24, start.y + 24);
        await dragPage.mouse.down();
        await dragPage.mouse.move(180, 190, { steps: 8 });
        await dragPage.mouse.up();
        draggedBox = await dragBall.boundingBox();
        assert.ok(draggedBox.x < 200 && draggedBox.y < 210);
        assert.equal(await dragBall.getAttribute("aria-expanded"), "false");
        assert.equal(
          await dragPage.locator("#bili-lens-video-tools iframe").count(),
          0,
        );
        assert.ok(
          (
            await worker.evaluate(() =>
              chrome.storage.local.get("lensVideoBallPosition"),
            )
          ).lensVideoBallPosition,
        );
      },
    );
    await check(
      "Launcher position survives a page reload and a click with slight pointer movement still opens tools",
      async () => {
        await dragPage.reload();
        await dragBall.waitFor();
        await dragPage.waitForFunction(({ x, y }) => {
          const ball = document
            .getElementById("bili-lens-video-tools")
            ?.shadowRoot.querySelector(".ball");
          if (!ball) return false;
          const box = ball.getBoundingClientRect();
          return Math.abs(box.x - x) < 1 && Math.abs(box.y - y) < 3;
        }, draggedBox);
        const box = await dragBall.boundingBox();
        await dragPage.mouse.move(box.x + 24, box.y + 24);
        await dragPage.mouse.down();
        await dragPage.mouse.move(box.x + 26, box.y + 25);
        await dragPage.mouse.up();
        assert.equal(await dragBall.getAttribute("aria-expanded"), "true");
        await dragPage
          .locator("#bili-lens-video-tools .drawer")
          .evaluate((el) =>
            Promise.all(el.getAnimations().map((a) => a.finished)),
          );
        const sideDrawer = await dragPage
          .locator("#bili-lens-video-tools .drawer")
          .boundingBox();
        const sideBall = await dragBall.boundingBox();
        assert.ok(sideDrawer.x >= sideBall.x + sideBall.width + 7);
        assert.ok(Math.abs(sideDrawer.y - sideBall.y) < 3);
        await dragPage
          .locator("#bili-lens-video-tools .drawer button")
          .first()
          .click();
        await dragBall.focus();
        await dragPage.keyboard.press("Enter");
        assert.equal(await dragBall.getAttribute("aria-expanded"), "true");
      },
    );
    await check(
      "Dragged launcher and its open drawer stay within viewport edges after dragging and resizing",
      async () => {
        await dragPage
          .locator("#bili-lens-video-tools .drawer button")
          .first()
          .click();
        const box = await dragBall.boundingBox();
        await dragPage.mouse.move(box.x + 24, box.y + 24);
        await dragPage.mouse.down();
        await dragPage.mouse.move(-300, 2000, { steps: 8 });
        await dragPage.mouse.up();
        await dragPage.setViewportSize({ width: 390, height: 500 });
        await dragPage.waitForFunction(() => {
          const box = document
            .getElementById("bili-lens-video-tools")
            .getBoundingClientRect();
          return box.left >= 0 && box.bottom <= innerHeight;
        });
        await dragBall.click();
        await dragPage
          .locator("#bili-lens-video-tools .drawer")
          .evaluate((el) =>
            Promise.all(el.getAnimations().map((a) => a.finished)),
          );
        for (const selector of [".ball", ".drawer"]) {
          const rect = await dragPage
            .locator(`#bili-lens-video-tools ${selector}`)
            .boundingBox();
          assert.ok(
            rect.x >= 0 &&
              rect.y >= 0 &&
              rect.x + rect.width <= 390 &&
              rect.y + rect.height <= 500,
          );
        }
        const ballRect = await dragBall.boundingBox();
        const drawerRect = await dragPage
          .locator("#bili-lens-video-tools .drawer")
          .boundingBox();
        assert.ok(
          drawerRect.x >= ballRect.x + ballRect.width + 7 ||
            drawerRect.x + drawerRect.width + 7 <= ballRect.x,
        );
        const iframe = await dragPage
          .locator("#bili-lens-video-tools iframe")
          .elementHandle();
        const inline = await iframe.contentFrame();
        await inline.waitForFunction(() => document.getElementById("load"));
        assert.equal(
          await inline.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await dragPage.screenshot({
          path: path.join(artifacts, "video-panel-side-390.png"),
        });
        await dragPage.close();
      },
    );
    await check(
      "Ended media and download records can be deleted individually without removing files or active dependencies",
      async () => {
        const tasks = await worker.evaluate(() => getTasks());
        const source = tasks.find((task) => task.state === "saved");
        assert.ok(source);
        const files = await worker.evaluate(() => chrome.downloads.search({}));
        const file = files.find((item) => item.id === source.downloadId);
        const before = fs.readFileSync(file.filename);
        await worker.evaluate(
          (sourceId) =>
            saveMediaJobs([
              ...["cancelled", "failed", "completed"].map((state) => ({
                id: `delete-${state}`,
                engine: "browser",
                state,
                title: `delete-${state}`,
                part: "P1",
                format: "mp4",
              })),
              {
                id: "delete-active",
                engine: "browser",
                state: "processing",
                title: "active",
                part: "P1",
                format: "mp4",
                videoTask: sourceId,
              },
            ]),
          source.id,
        );
        await site.bringToFront();
        await site.setViewportSize({ width: 1440, height: 1000 });
        await frame.locator('[data-tab="queue"]').focus();
        await site.keyboard.press("Enter");
        await frame.locator("#refresh-tasks").click();
        await frame
          .locator("#media-jobs tr")
          .filter({ hasText: "delete-cancelled" })
          .waitFor();
        const active = frame
          .locator("#media-jobs tr")
          .filter({ hasText: "active" });
        assert.equal(
          await active
            .getByRole("button", { name: "删除记录", exact: true })
            .count(),
          0,
        );
        for (const message of [
          { op: "mediaAction", jobId: "delete-active", action: "delete" },
          { op: "taskAction", taskId: source.id, action: "delete" },
        ]) {
          const reply = await frame.evaluate(
            (message) => chrome.runtime.sendMessage(message),
            message,
          );
          assert.equal(reply.ok, false);
          assert.match(reply.error, /停止|仍在使用/);
        }
        for (const state of ["cancelled", "failed", "completed"]) {
          const row = frame
            .locator("#media-jobs tr")
            .filter({ hasText: `delete-${state}` });
          await row
            .getByRole("button", { name: "删除记录", exact: true })
            .focus();
          await site.keyboard.press("Enter");
          await row.waitFor({ state: "detached" });
        }
        assert.deepEqual(
          (await worker.evaluate(() => getMediaJobs())).map((job) => job.id),
          ["delete-active"],
        );
        await worker.evaluate(() => saveMediaJobs([]));
        const downloadRow = frame
          .locator("#tasks tr")
          .filter({ hasText: source.part })
          .filter({ hasText: source.kind });
        await downloadRow
          .getByRole("button", { name: "删除记录", exact: true })
          .first()
          .focus();
        await site.keyboard.press("Enter");
        await frame.waitForFunction(
          (count) => document.querySelectorAll("#tasks tr").length === count,
          tasks.length - 1,
        );
        assert.equal(
          (await worker.evaluate(() => getTasks())).some(
            (task) => task.id === source.id,
          ),
          false,
        );
        assert.deepEqual(fs.readFileSync(file.filename), before);
      },
    );
    await check(
      "Disabling video modules disposes the widget and frame without script errors",
      async () => {
        await worker.evaluate(async () => {
          const settings = await LensSettings.load();
          settings.modules.tools = false;
          settings.modules.player = false;
          await LensSettings.save(settings);
        });
        await site
          .locator("#bili-lens-video-tools")
          .waitFor({ state: "detached" });
        assert.equal(errors.length, 0, errors.join("\n"));
      },
    );
    fs.writeFileSync(
      path.join(artifacts, "video-panel-report.json"),
      JSON.stringify(
        {
          version: manifest.version,
          checks,
          errors,
          network: "fixture-only",
          nativeHelper: "not tested",
          passed: true,
        },
        null,
        2,
      ),
    );
    console.log(checks + " actual-extension video panel checks passed");
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
