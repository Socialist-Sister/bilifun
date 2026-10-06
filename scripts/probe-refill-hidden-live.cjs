/* Explicit public-page QA; disposable signed-out profile and session records. */
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
(async () => {
  const source = fs.mkdtempSync(
    path.join(artifacts, "refill-hidden-extension-"),
  );
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://api.bilibili.com/*"];
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (host) => host !== "https://api.bilibili.com/*",
    );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(artifacts, "refill-hidden-profile-")),
    {
      headless: true,
      executablePath: process.env.TEST_BROWSER_EXECUTABLE,
      args: [
        `--disable-extensions-except=${source}`,
        `--load-extension=${source}`,
      ],
      viewport: { width: 1440, height: 1000 },
    },
  );
  const report = {
    date: new Date().toISOString(),
    version: manifest.version,
    measurements: [],
  };
  try {
    await context.route("**/*", (route) =>
      ["font", "media"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker")),
      options = await context.newPage(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    await page.goto("https://search.bilibili.com/video?keyword=6.1sol&page=2", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page
      .locator(".bili-video-card")
      .first()
      .waitFor({ state: "attached" });
    await options.waitForFunction(
      async () =>
        Object.keys(
          (await chrome.storage.session.get("lensSearchPagesV1"))
            .lensSearchPagesV1 || {},
        ).length > 0,
    );
    await page.waitForTimeout(800);
    const ids = await page
      .locator(".bili-video-card a[href]")
      .evaluateAll((anchors) => [
        ...new Set(
          anchors
            .map(
              (a) =>
                /\/video\/(BV\w{8,22}|av\d{1,16})(?:\/|$)/.exec(
                  new URL(a.href).pathname,
                )?.[1],
            )
            .filter(Boolean),
        ),
      ]);
    assert.ok(ids.length);
    // Seed only this disposable tab's records to emulate every native page-two
    // result having already been borrowed on page one. Public responses stay real.
    await options.evaluate(async (ids) => {
      const data = (await chrome.storage.session.get("lensSearchPagesV1"))
          .lensSearchPagesV1,
        state = Object.values(data)[0];
      state.owners = Object.fromEntries(ids.map((id) => [id, 1]));
      await chrome.storage.session.set({ lensSearchPagesV1: data });
    }, ids);
    report.seededNativeIds = ids.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-lens-refill-owned]").length > 0,
      null,
      { timeout: 45000 },
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(800);
      const measurement = await page.evaluate(() => {
        const owned = [
            ...document.querySelectorAll("[data-lens-refill-owned]"),
          ],
          native = [...document.querySelectorAll(".bili-video-card")].filter(
            (node) =>
              [...node.querySelectorAll("a[href]")].some((a) =>
                /\/video\/(?:BV|av)/.test(a.pathname),
              ),
          ),
          nativeHidden = native.every(
            (node) => !node.getBoundingClientRect().width,
          ),
          markers = [
            ...document.querySelectorAll(
              "[data-bili-search-lens-hidden], [data-lens-search-slot-hidden]",
            ),
          ].flatMap((node) =>
            ["data-bili-search-lens-hidden", "data-lens-search-slot-hidden"]
              .filter((name) => node.hasAttribute(name))
              .map((name) => [node, name, node.getAttribute(name)]),
          );
        let expected;
        try {
          for (const [node, name] of markers) node.removeAttribute(name);
          let slot = native.find(
            (node) => node.getBoundingClientRect().width > 0,
          );
          for (let depth = 0; depth < 3 && slot; depth++) {
            const parent = slot.parentElement;
            if (!parent || parent.children.length !== 1) break;
            if (
              [...parent.classList].some((name) => /^col[_-]/.test(name)) ||
              /^(flex|grid|inline-flex|inline-grid)$/.test(
                getComputedStyle(parent.parentElement).display,
              )
            )
              slot = parent;
            else break;
          }
          expected = slot?.getBoundingClientRect().width;
        } finally {
          for (const [node, name, value] of markers)
            node.setAttribute(name, value);
        }
        return {
          viewport: innerWidth,
          nativeHidden,
          expected,
          widths: owned.map((node) => node.getBoundingClientRect().width),
          status: document
            .getElementById("bili-search-lens")
            .shadowRoot.getElementById("fill-status").textContent,
        };
      });
      assert.ok(measurement.nativeHidden, JSON.stringify(measurement));
      assert.ok(measurement.expected > 0 && measurement.widths.length);
      for (const measured of measurement.widths)
        assert.ok(
          Math.abs(measured - measurement.expected) < 1,
          JSON.stringify(measurement),
        );
      report.measurements.push(measurement);
      await page
        .locator("#bili-search-lens")
        .evaluate((node) => (node.style.visibility = "hidden"));
      await page.screenshot({
        path: path.join(artifacts, `refill-hidden-live-${width}.png`),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    report.verified = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.writeFileSync(
      path.join(artifacts, "live-refill-hidden-report.json"),
      JSON.stringify(report, null, 2),
    );
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
