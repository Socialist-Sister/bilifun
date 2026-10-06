/* Real MV3 tools UI and cancel messages, API-origin-only QA copy, no user profile or network. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
let checks = 0;
async function check(name, action) {
  await action();
  checks++;
  console.log("PASS " + name);
}
async function waitWorker(worker, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await worker.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Worker condition timed out");
}
(async () => {
  const source = fs.mkdtempSync(path.join(artifacts, "loading-extension-"));
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (origin) => origin !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(artifacts, "loading-profile-")),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
    },
  );
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(() => {
      globalThis.loadingQA = {
        mode: "success",
        calls: 0,
        started: 0,
        aborted: 0,
        releases: [],
      };
      api.signature = async (params) => new URLSearchParams(params).toString();
      api.fetcher = async (url, { signal }) => {
        loadingQA.calls++;
        const parsed = new URL(url),
          metadata = parsed.pathname === "/x/web-interface/view";
        if (
          (metadata && ["hang", "late"].includes(loadingQA.mode)) ||
          (!metadata && loadingQA.mode === "streams-hang")
        ) {
          const late = loadingQA.mode === "late";
          loadingQA.started++;
          await new Promise((resolve, reject) => {
            const abort = () => {
              loadingQA.aborted++;
              if (!late) reject(new DOMException("Aborted", "AbortError"));
            };
            if (signal.aborted) {
              abort();
              return;
            }
            signal.addEventListener("abort", abort, { once: true });
            loadingQA.releases.push(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            });
          });
        }
        if (loadingQA.mode === "error")
          return new Response(JSON.stringify({ code: -404 }));
        return new Response(
          JSON.stringify({
            code: 0,
            data: metadata
              ? {
                  bvid: parsed.searchParams.get("bvid"),
                  title: "视频 " + parsed.searchParams.get("bvid"),
                  owner: { mid: 123, name: "测试 UP" },
                  pages: [
                    { cid: 1001, page: 1, part: "第一 P", duration: 2 },
                    { cid: 1002, page: 2, part: "第二 P", duration: 2 },
                  ],
                }
              : {
                  timelength: 2000,
                  dash: {
                    video: [
                      {
                        id: 80,
                        bandwidth: 100000,
                        codecs: "avc1",
                        baseUrl: "https://cdn.bilivideo.com/video.m4s",
                      },
                    ],
                    audio: [
                      {
                        id: 30280,
                        bandwidth: 10000,
                        codecs: "mp4a",
                        baseUrl: "https://cdn.bilivideo.com/audio.m4s",
                      },
                    ],
                  },
                },
          }),
        );
      };
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(
      worker.url().replace("background.js", "tools.html?id=BV1UftJ6rE4o&p=2"),
    );
    await page.waitForFunction(() => !document.getElementById("load").disabled);
    await page.evaluate(() => {
      globalThis.permissionRequests = [];
      chrome.permissions.request = async (request) => {
        permissionRequests.push(request);
        return false;
      };
    });
    const status = () => page.locator("#status").textContent();
    async function load(id = "BV1UftJ6rE4o") {
      await page.locator("#video-input").fill(id);
      await page.locator("#load").click();
      await page.waitForFunction(() =>
        document
          .getElementById("status")
          .textContent.includes("视频信息已读取"),
      );
    }
    await check(
      "API-only permission can load metadata and preserve the requested part without asking for extra permissions",
      async () => {
        await page.locator("#load").click();
        await page.waitForFunction(() =>
          document
            .getElementById("status")
            .textContent.includes("视频信息已读取"),
        );
        assert.equal(await page.locator("#page-select").inputValue(), "1002");
        assert.deepEqual(await page.evaluate(() => permissionRequests), []);
        assert.equal(
          await worker.evaluate(() =>
            chrome.permissions.contains({
              permissions: ["declarativeNetRequestWithHostAccess"],
            }),
          ),
          false,
        );
      },
    );
    await check(
      "Invalid inputs fail before networking or permission prompts",
      async () => {
        const calls = await worker.evaluate(() => loadingQA.calls);
        await page.locator("#video-input").fill("not-a-video");
        await page.locator("#load").click();
        assert.match(await status(), /有效/);
        assert.equal(await worker.evaluate(() => loadingQA.calls), calls);
      },
    );
    await check(
      "A new pending metadata read clears old metadata and Stop aborts the real API request",
      async () => {
        await worker.evaluate(() => {
          loadingQA.mode = "hang";
        });
        await page.locator("#video-input").fill("BV1EHDSYzEEd");
        await page.locator("#load").click();
        await waitWorker(worker, () => loadingQA.started === 1);
        assert.equal(await page.locator("#video-title").textContent(), "");
        assert.ok(await page.locator("#page-select").isDisabled());
        await page.locator("#cancel-read").click();
        await page.waitForFunction(
          () => !document.getElementById("load").disabled,
        );
        await waitWorker(worker, () => loadingQA.aborted >= 1);
        assert.match(await status(), /已停止/);
        assert.equal(await page.locator("#page-select").inputValue(), "");
      },
    );
    await check(
      "A hanging worker reaches the page's 25-second deadline and retry is available",
      async () => {
        await page.locator("#load").click();
        await waitWorker(worker, () => loadingQA.started === 2);
        await page.clock.fastForward(25001);
        await page.waitForFunction(
          () => !document.getElementById("load").disabled,
        );
        assert.match(await status(), /超过 25 秒/);
        await waitWorker(worker, () => loadingQA.aborted >= 2);
        await worker.evaluate(() => {
          loadingQA.mode = "success";
        });
        await load();
        assert.ok(await page.locator("#metadata").isEnabled());
      },
    );
    await check(
      "Changing the input cancels the old read and its late response cannot replace the new video's metadata",
      async () => {
        await worker.evaluate(() => {
          loadingQA.mode = "late";
        });
        await page.locator("#video-input").fill("BV1EHDSYzEEd");
        await page.locator("#load").click();
        await waitWorker(worker, () => loadingQA.started === 3);
        await page.locator("#video-input").fill("BV1KM4y1U7yA");
        await page.waitForFunction(
          () => !document.getElementById("load").disabled,
        );
        await worker.evaluate(() => {
          loadingQA.mode = "success";
        });
        await load("BV1KM4y1U7yA");
        await worker.evaluate(() =>
          loadingQA.releases.splice(0).forEach((release) => release()),
        );
        await waitWorker(worker, () => resourceRequests.size === 0);
        assert.match(
          await page.locator("#video-title").textContent(),
          /BV1KM4y1U7yA/,
        );
      },
    );
    await check(
      "A failed diagnostic store cannot swallow an API error and leave the UI reading",
      async () => {
        await worker.evaluate(() => {
          loadingQA.mode = "error";
          globalThis.originalStorageGet = chrome.storage.local.get.bind(
            chrome.storage.local,
          );
          chrome.storage.local.get = (key) =>
            key === "lensRecentErrors"
              ? new Promise(() => {})
              : originalStorageGet(key);
        });
        await page.locator("#load").click();
        await page.waitForFunction(
          () => !document.getElementById("load").disabled,
        );
        assert.match(await status(), /不存在/);
        await worker.evaluate(() => {
          chrome.storage.local.get = originalStorageGet;
          loadingQA.mode = "success";
        });
        await load();
      },
    );
    await check(
      "Media tracks load with API permission only; a hanging stream read has the same deadline and cancellation",
      async () => {
        await page.locator("#get-streams").click();
        await page.waitForFunction(() =>
          document
            .getElementById("status")
            .textContent.includes("可用视频轨道"),
        );
        assert.equal(await page.locator("#video-track option").count(), 2);
        assert.deepEqual(await page.evaluate(() => permissionRequests), []);
        await worker.evaluate(() => {
          resourceCache.clear();
          loadingQA.mode = "streams-hang";
        });
        await page.locator("#get-streams").click();
        await waitWorker(worker, () => loadingQA.started === 4);
        await page.clock.fastForward(25001);
        await page.waitForFunction(
          () => !document.getElementById("get-streams").disabled,
        );
        assert.match(await status(), /超过 25 秒/);
        assert.equal(await page.locator("#video-track option").count(), 1);
        await waitWorker(worker, () => loadingQA.aborted >= 4);
      },
    );
    await check(
      "Part changes abort active streams and prevent late resources from populating the newly selected part",
      async () => {
        await page.locator("#get-streams").click();
        await waitWorker(worker, () => loadingQA.started === 5);
        const selected = await page.locator("#page-select").inputValue();
        await page
          .locator("#page-select")
          .selectOption(selected === "1001" ? "1002" : "1001");
        await page.waitForFunction(
          () => !document.getElementById("get-streams").disabled,
        );
        await waitWorker(worker, () => loadingQA.aborted >= 5);
        assert.match(await status(), /切换分 P/);
        assert.equal(await page.locator("#video-track option").count(), 1);
      },
    );
    await check(
      "Refreshing replaces a recent incomplete cache and displays all five qualities plus audio through safe backups",
      async () => {
        const selected = Number(
          await page.locator("#page-select").inputValue(),
        );
        await worker.evaluate((cid) => {
          resourceCache.set(`BV1UftJ6rE4o:${cid}`, {
            time: Date.now(),
            value: { video: [], audio: [], direct: [] },
          });
          loadingQA.backupReads = 0;
          api.fetcher = async () => {
            loadingQA.backupReads++;
            const track = (id, codecs) => ({
              id,
              codecs,
              baseUrl: "https://mcdn.bilivideo.cn:8082/resource.m4s",
              backupUrl: ["https://upos.bilivideo.com/resource.m4s"],
            });
            return new Response(
              JSON.stringify({
                code: 0,
                data: {
                  support_formats: [112, 80, 64, 32, 16].map((quality) => ({
                    quality,
                    new_description: `Q${quality}`,
                  })),
                  dash: {
                    video: [112, 80, 64, 32, 16].map((id) => track(id, "avc1")),
                    audio: [30280, 30232, 30216].map((id) => track(id, "mp4a")),
                  },
                },
              }),
            );
          };
        }, selected);
        await page.locator("#get-streams").click();
        await page.waitForFunction(() =>
          document
            .getElementById("status")
            .textContent.includes("可用视频轨道 5 条"),
        );
        assert.equal(
          await page.locator("#video-track option:not([disabled])").count(),
          6,
        );
        assert.equal(await page.locator("#audio-track option").count(), 4);
        assert.equal(await worker.evaluate(() => loadingQA.backupReads), 1);
        assert.match(
          await page.locator("#audio-track").inputValue(),
          /^audio:/,
        );
        assert.deepEqual(await page.evaluate(() => permissionRequests), []);
      },
    );
    await check(
      "Unreturned qualities are disabled and missing independent audio is explained without fabricated tracks",
      async () => {
        await worker.evaluate(() => {
          api.fetcher = async () =>
            new Response(
              JSON.stringify({
                code: 0,
                data: {
                  support_formats: [112, 80, 64, 32, 16].map((quality) => ({
                    quality,
                    new_description: `Q${quality}`,
                  })),
                  dash: {
                    video: [
                      {
                        id: 16,
                        codecs: "avc1",
                        baseUrl: "https://cdn.bilivideo.com/v",
                      },
                    ],
                    audio: [],
                  },
                },
              }),
            );
        });
        await page.locator("#get-streams").click();
        await page.waitForFunction(() =>
          document
            .getElementById("status")
            .textContent.includes("未取得独立音轨"),
        );
        assert.equal(
          await page.locator("#video-track option[disabled]").count(),
          4,
        );
        assert.equal(await page.locator("#audio-track option").count(), 1);
        assert.match(
          await page.locator("#audio-track").textContent(),
          /接口未返回音轨链接/,
        );
        assert.match(await status(), /4 种清晰度未返回下载链接/);
      },
    );
    await check(
      "Loading controls fit narrow screens, no runtime errors occur and request controllers are cleaned",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await waitWorker(
          worker,
          () => resourceRequests.size === 0 && api.controllers.size === 0,
        );
        assert.deepEqual(errors, []);
      },
    );
    console.log(`${checks} actual-extension loading checks passed`);
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
