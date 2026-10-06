/* Controlled DOM transitions using the actual controller, adapter and rules. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const profile = fs.mkdtempSync(
    path.join(artifacts, "refill-controller-profile-"),
  );
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.TEST_BROWSER_EXECUTABLE,
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<style>.list{display:flex;flex-wrap:wrap}.col_3{width:100px}</style><div class="list"></div>',
    );
    for (const name of ["core.js", "adapter.js", "refill.js"])
      await page.addScriptTag({ path: path.join(root, "extension", name) });
    const results = await page.evaluate(async () => {
      const list = document.querySelector(".list"),
        id = (n) => "BV1fill" + String(n).padStart(6, "0");
      const row = (n) => ({
        videoId: id(n),
        aliases: [id(n)],
        title: "贾队长 " + n,
        url: "https://www.bilibili.com/video/" + id(n),
      });
      const native = (count) => {
        for (const node of list.querySelectorAll(".col_3")) node.remove();
        for (let n = 1; n <= count; n++) {
          const slot = document.createElement("div"),
            card = document.createElement("article");
          slot.className = "col_3";
          card.className = "bili-video-card";
          card.textContent = "native";
          card.dataset.videoId = id(n);
          slot.append(card);
          list.append(slot);
        }
      };
      const args = (exclusions) => ({
        url: "https://search.bilibili.com/video?keyword=贾队长&page=1",
        entries: [...list.querySelectorAll(".bili-video-card")].map(
          (element, n) => ({
            card: { element, videoId: element.dataset.videoId },
            keep: n < 2,
          }),
        ),
        rules: BiliSearchLens.compileRules(
          "贾队长",
          exclusions || "",
          "related",
        ),
        options: {},
        enabled: true,
        waiting: false,
        permission: true,
      });
      const calls = [],
        pending = [];
      const controller = new LensRefill.Controller(
        (message, options) => {
          calls.push({ ...message, signal: options.signal });
          return new Promise((resolve) => pending.push({ resolve, message }));
        },
        () => {},
      );
      const settle = async (rows = []) => {
        const request = pending.shift();
        request.resolve({
          rows,
          pageSize: request.message.pageSize,
          totalPages: 100,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      native(6);
      controller.update(args());
      await settle([row(7)]);
      controller.update(args());
      native(12);
      controller.update(args());
      const repartition = {
        calls: calls.map((c) => [c.page, c.pageSize]),
        cancelled: calls[1].signal.aborted,
        pool: controller.pool.length,
        pages: controller.pages,
      };
      // Even a transport which ignores abort must not contribute the old response.
      await settle([row(80)]);
      await settle([row(20)]);
      const stale = {
        ids: controller.pool.map((r) => r.videoId),
        error: controller.error,
        pages: controller.pages,
      };
      controller.destroy();
      calls.length = 0;
      native(6);
      controller.update(args());
      native(12);
      controller.update(args());
      const inFlight = {
        calls: calls.map((c) => [c.page, c.pageSize]),
        cancelled: calls[0].signal.aborted,
      };
      await settle([row(81)]);
      await settle([row(21)]);
      inFlight.ids = controller.pool.map((r) => r.videoId);
      inFlight.error = controller.error;
      controller.destroy();
      native(6);
      controller.update({ ...args(), waiting: true });
      controller.pool = [7, 8, 9, 10, 11].map((n) => ({
        ...row(n),
        sourcePage: 2,
      }));
      controller.update(args("8"));
      const order = () =>
        [...list.querySelectorAll("[data-lens-refill-owned]")].map(
          (n) => n.dataset.videoId,
        );
      const excluded = order();
      controller.update(args());
      const restored = order(),
        items = controller.items.map((r) => r.videoId);
      let mutations = 0;
      const observer = new MutationObserver(
        (records) =>
          (mutations += records.filter((r) => r.type === "childList").length),
      );
      observer.observe(list, { childList: true });
      for (let n = 0; n < 10; n++) controller.update(args());
      await new Promise((resolve) => setTimeout(resolve, 0));
      observer.disconnect();
      controller.destroy();
      return {
        repartition,
        stale,
        inFlight,
        excluded,
        restored,
        items,
        mutations,
      };
    });
    assert.deepEqual(results.repartition.calls, [
      [2, 6],
      [3, 6],
      [2, 12],
    ]);
    assert.equal(results.repartition.cancelled, true);
    assert.equal(results.repartition.pool, 0);
    assert.equal(results.repartition.pages, 0);
    console.log(
      "PASS Completed-page cache resets before changing the pagination partition",
    );
    assert.deepEqual(results.stale.ids, ["BV1fill000020"]);
    assert.equal(results.stale.error, "");
    assert.equal(results.stale.pages, 1);
    assert.deepEqual(results.inFlight.calls, [
      [2, 6],
      [2, 12],
    ]);
    assert.equal(results.inFlight.cancelled, true);
    assert.deepEqual(results.inFlight.ids, ["BV1fill000021"]);
    assert.equal(results.inFlight.error, "");
    console.log(
      "PASS In-flight page-size changes cancel and ignore old responses without false mismatch errors",
    );
    assert.deepEqual(
      results.excluded,
      [7, 9, 10, 11].map((n) => "BV1fill" + String(n).padStart(6, "0")),
    );
    assert.deepEqual(
      results.restored,
      [7, 8, 9, 10].map((n) => "BV1fill" + String(n).padStart(6, "0")),
    );
    assert.deepEqual(results.restored, results.items);
    console.log(
      "PASS Restoring a middle candidate preserves source order in the actual DOM",
    );
    assert.equal(results.mutations, 0);
    console.log(
      "PASS Stable updates do not move nodes or create a mutation-observer feedback loop",
    );
    console.log("4 controller browser checks passed");
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
