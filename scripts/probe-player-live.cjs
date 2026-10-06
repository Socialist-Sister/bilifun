/* Experimental playback adapter QA, in an isolated signed-out profile. */
const fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
const directory = fs.mkdtempSync(
    path.join(artifacts, "player-live-extension-"),
  ),
  profile = fs.mkdtempSync(path.join(artifacts, "player-live-profile-"));
fs.cpSync(path.join(root, "extension"), directory, { recursive: true });
const manifest = JSON.parse(
  fs.readFileSync(path.join(directory, "manifest.json")),
);
manifest.permissions.push("declarativeNetRequestWithHostAccess");
manifest.host_permissions = ["https://api.bilibili.com/*"];
manifest.optional_permissions = manifest.optional_permissions.filter(
  (p) => p !== "declarativeNetRequestWithHostAccess",
);
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify(manifest),
);
(async () => {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
    args: [
      `--disable-extensions-except=${directory}`,
      `--load-extension=${directory}`,
    ],
  });
  const report = {
    date: new Date().toISOString(),
    session: "isolated browser/no account",
  };
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      const settings = await LensSettings.load();
      settings.modules.player = true;
      await LensSettings.save(settings);
      await prepareHeaders();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto("https://www.bilibili.com/video/BV1UftJ6rE4o/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("#bili-lens-video-tools");
    await page
      .getByRole("button", { name: "展开视频工具", exact: true })
      .click();
    report.structure = await page.evaluate(() => ({
      video: !!document.querySelector(
        ".bpx-player-video-wrap video,.bpx-player-video-area video",
      ),
      area: !!document.querySelector(".bpx-player-video-area"),
      nativeLayer: !!document.querySelector(".bpx-player-dm-wrap"),
      contained: !!document.querySelector(
        ".bpx-player-video-area .bpx-player-dm-wrap",
      ),
      areaChildren: [
        ...document.querySelector(".bpx-player-video-area").children,
      ].map((el) => ({
        tag: el.tagName,
        class: el.className,
        children: [...el.children].map((child) => ({
          tag: child.tagName,
          class: child.className,
        })),
      })),
      danmakuElements: [...document.querySelectorAll('[class*="dm-"]')]
        .slice(0, 25)
        .map((el) => ({ tag: el.tagName, class: el.className })),
    }));
    await page
      .locator("#bili-lens-video-tools button")
      .getByText("启用过滤弹幕（实验）")
      .click();
    await page.waitForFunction(() => {
      const text = document
        .getElementById("bili-lens-video-tools")
        .shadowRoot.querySelector("p").textContent;
      return (
        text.includes("已载入") ||
        text.includes("离线") ||
        text.includes("已恢复")
      );
    });
    report.overlay = await page.evaluate(() => ({
      mounted: !!document.querySelector("[data-lens-overlay]"),
      nativeVisibility:
        document.querySelector(".bpx-player-render-dm-wrap,.bpx-player-dm-wrap")
          ?.style.visibility || "",
      message: document
        .getElementById("bili-lens-video-tools")
        .shadowRoot.querySelector("p").textContent,
    }));
    await worker.evaluate(async () => {
      const s = await LensSettings.load();
      s.modules.player = false;
      await LensSettings.save(s);
    });
    await page.waitForFunction(
      () => !document.querySelector("[data-lens-overlay]"),
    );
    report.disabled = await page.evaluate(() => ({
      overlayRemoved: !document.querySelector("[data-lens-overlay]"),
      nativeVisibility:
        document.querySelector(".bpx-player-render-dm-wrap,.bpx-player-dm-wrap")
          ?.style.visibility || "",
    }));
  } catch (error) {
    report.error = String(error.message)
      .replace(/https?:\/\/\S+/g, "[hidden]")
      .slice(0, 300);
  } finally {
    await context.close();
    fs.writeFileSync(
      path.join(artifacts, "live-player-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
