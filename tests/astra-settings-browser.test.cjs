/* Two real MV3 documents, disposable profile, no external requests or user data. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
async function workerWait(worker, predicate) {
  for (let i = 0; i < 100; i++) {
    if (await worker.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Settings worker state timed out");
}
(async () => {
  const source = fs.mkdtempSync(
    path.join(artifacts, "astra-settings-extension-"),
  );
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  fs.writeFileSync(
    path.join(source, "astra-settings.html"),
    '<!doctype html><meta charset="utf-8"><title>Settings test document</title><script src="settings.js"></script>',
  );
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(artifacts, "astra-settings-profile-")),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
    },
  );
  let checks = 0;
  try {
    await context.route("https://**/*", (route) => route.abort());
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const url = worker.url().replace("background.js", "astra-settings.html");
    const [reader, editor] = await Promise.all([
      context.newPage(),
      context.newPage(),
    ]);
    await Promise.all([reader.goto(url), editor.goto(url)]);
    for (const page of [reader, editor])
      await page.evaluate(() => {
        globalThis.settingsMessages = [];
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (message, ...args) => {
          settingsMessages.push(message.op);
          return send(message, ...args);
        };
      });
    for (const legacyOnly of [false, true]) {
      await worker.evaluate(async (legacyOnly) => {
        await chrome.storage.local.remove([
          "lensSettingsV2",
          "biliSearchLensSettings",
        ]);
        await chrome.storage.local.set(
          legacyOnly
            ? {
                biliSearchLensSettings: { enabled: true, exclusions: "旧规则" },
              }
            : {
                lensSettingsV2: {
                  version: 2,
                  modules: { search: true },
                  search: { relevanceVersion: 1, exclusions: "旧规则" },
                  downloads: { concurrent: 2 },
                },
              },
        );
        globalThis.settingsQA = { captured: false, releases: [] };
        const get = chrome.storage.local.get.bind(chrome.storage.local);
        globalThis.settingsOriginalGet = get;
        chrome.storage.local.get = async (keys) => {
          const snapshot = await get(keys);
          if (
            !settingsQA.captured &&
            Array.isArray(keys) &&
            keys.includes("lensSettingsV2")
          ) {
            settingsQA.captured = true;
            await new Promise((resolve) => settingsQA.releases.push(resolve));
          }
          return snapshot;
        };
      }, legacyOnly);
      await reader.evaluate(() => {
        globalThis.pendingLoad = LensSettings.load();
      });
      await workerWait(worker, () => settingsQA.captured);
      await editor.evaluate(() => {
        const value = LensSettings.copy(LensSettings.defaults);
        value.modules.search = true;
        value.search.fillPages = true;
        value.search.exclusions = "用户刚保存的规则";
        value.downloads.concurrent = 3;
        globalThis.saveSettled = false;
        globalThis.pendingSave = LensSettings.save(value).finally(() => {
          saveSettled = true;
        });
      });
      await editor.waitForTimeout(100);
      assert.equal(await editor.evaluate(() => saveSettled), false);
      await worker.evaluate(() =>
        settingsQA.releases.forEach((resolve) => resolve()),
      );
      const migrated = await reader.evaluate(() => pendingLoad);
      const saved = await editor.evaluate(() => pendingSave);
      assert.equal(migrated.modules.search, false);
      assert.equal(saved.modules.search, true);
      for (const page of [reader, editor]) {
        const current = await page.evaluate(() => LensSettings.load());
        assert.equal(current.modules.search, true);
        assert.equal(current.search.fillPages, true);
        assert.equal(current.search.exclusions, "用户刚保存的规则");
        assert.equal(current.downloads.concurrent, 3);
        assert.equal(current.searchExperienceVersion, 1);
      }
      await worker.evaluate(() => {
        chrome.storage.local.get = settingsOriginalGet;
      });
      checks++;
      console.log(
        "PASS queued migration before explicit save across two MV3 documents: " +
          (legacyOnly ? "legacy-only" : "V2 upgrade"),
      );
    }
    assert.ok(
      (await reader.evaluate(() => settingsMessages)).includes("settingsLoad"),
    );
    const operations = await editor.evaluate(() => settingsMessages);
    assert.ok(operations.includes("settingsSave"));
    assert.ok(operations.includes("settingsLoad"));
    checks++;
    console.log(
      "PASS document APIs route reads and writes through worker messages",
    );
    await Promise.all([reader.reload(), editor.reload()]);
    const values = await Promise.all(
      [reader, editor].map((page) => page.evaluate(() => LensSettings.load())),
    );
    assert.ok(values.every((value) => value.modules.search));
    assert.ok(
      values.every((value) => value.search.exclusions === "用户刚保存的规则"),
    );
    checks++;
    console.log("PASS explicit save survives reloading both documents");
    const report = path.join(
      artifacts,
      "astra-settings-regression-" + Date.now() + ".json",
    );
    fs.writeFileSync(
      report,
      JSON.stringify({ checks, network: "none", passed: true }, null, 2),
    );
    console.log(checks + " actual-extension settings checks passed");
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
