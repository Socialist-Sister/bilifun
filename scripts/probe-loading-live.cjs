/* Explicit network QA: production tools UI, disposable Edge, API origin only. No downloads. */
const fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
(async () => {
  const source = fs.mkdtempSync(
    path.join(artifacts, "loading-live-extension-"),
  );
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
    fs.mkdtempSync(path.join(artifacts, "loading-live-profile-")),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
    },
  );
  const report = {
    date: new Date().toISOString(),
    version: manifest.version,
    session: "isolated/no account, API origin only in QA copy",
    checks: [],
  };
  try {
    const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker")),
      page = await context.newPage();
    await page.goto(
      worker.url().replace("background.js", "tools.html?id=BV1UftJ6rE4o"),
    );
    await page.waitForFunction(() => !document.getElementById("load").disabled);
    await page.evaluate(() => {
      globalThis.permissionRequests = [];
      chrome.permissions.request = async (request) => {
        permissionRequests.push(request);
        return false;
      };
    });
    for (const [id, label] of [
      ["load", "metadata"],
      ["get-streams", "streams"],
    ]) {
      const started = Date.now();
      await page.locator("#" + id).click();
      await page.waitForFunction(
        (id) => !document.getElementById(id).disabled,
        id,
        { timeout: 30000 },
      );
      const status = await page.locator("#status").textContent();
      const error = await page
        .locator("#status")
        .evaluate((node) => node.classList.contains("error"));
      report.checks.push({
        operation: label,
        milliseconds: Date.now() - started,
        status,
        error,
      });
      if (error) {
        process.exitCode = 1;
        break;
      }
    }
    report.permissionRequests = await page.evaluate(() => permissionRequests);
    report.noHeaderPermission = !(await worker.evaluate(() =>
      chrome.permissions.contains({
        permissions: ["declarativeNetRequestWithHostAccess"],
      }),
    ));
    report.trackCounts = {
      video: (await page.locator("#video-track option").count()) - 1,
      audio: (await page.locator("#audio-track option").count()) - 1,
    };
    if (report.permissionRequests.length) process.exitCode = 1;
  } catch (error) {
    report.error = String(error.message)
      .replace(/https?:\/\/\S+/g, "[hidden]")
      .slice(0, 300);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(artifacts, "live-loading-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    await context.close();
  }
})();
