const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { Session, LIMIT } = require("../extension/search-session.js"),
  settings = require("../extension/settings.js");
const Api = require("../extension/api.js");
require("../extension/refill.js");
const row = (n, title = "【终末地】1.5活动基建作业") => ({
  bvid: "BV1test" + String(n).padStart(6, "0"),
  title,
  aliases: ["av" + n],
  tags: [],
});
const response = (rows) => ({ rows, totalPages: 3, rawCount: rows.length });
test("Settings migration and explicit saves serialize the entire read/write transaction", async () => {
  const saved = {
    lensSettingsV2: {
      version: 2,
      modules: { search: true },
      search: { exclusions: "旧规则" },
    },
  };
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let first = true;
  const storage = {
    get: async () => {
      const snapshot = structuredClone(saved);
      if (first) {
        first = false;
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return snapshot;
    },
    set: async (change) => Object.assign(saved, structuredClone(change)),
  };
  const migration = settings.load(storage);
  await started;
  const explicit = settings.copy(settings.defaults);
  explicit.modules.search = true;
  explicit.search.fillPages = true;
  explicit.search.exclusions = "用户新规则";
  explicit.downloads.concurrent = 3;
  const write = settings.save(explicit, storage),
    read = settings.load(storage);
  release();
  await migration;
  await write;
  const value = await read;
  assert.equal(value.modules.search, true);
  assert.equal(value.search.fillPages, true);
  assert.equal(value.search.exclusions, "用户新规则");
  assert.equal(value.downloads.concurrent, 3);
  assert.deepEqual(saved.lensSettingsV2, value);
});
test("A failed middle query is retried before other queries advance to their next page", async () => {
  const calls = [];
  let failB = true;
  const session = new Session(async ({ keyword, page }) => {
    calls.push(`${keyword}${page}`);
    if (keyword === "B" && failB) {
      failB = false;
      throw new Error("B failed");
    }
    if (keyword === "A" && page === 2) throw new Error("A2 failed");
    return response([row(calls.length)]);
  });
  session.start("A", ["B", "C"]);
  await session.load();
  assert.match(session.error, /B failed/);
  await session.load();
  assert.equal(session.error, "");
  assert.deepEqual(calls, ["A1", "B1", "B1", "C1"]);
  assert.equal(session.pages, 3);
  await session.load();
  assert.match(session.error, /A2 failed/);
  assert.equal(calls.at(-1), "A2");
});
test("Stopping a multiquery round resumes the unfinished source, preserving completed pages", async () => {
  const calls = [];
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let wait = true;
  const session = new Session(async ({ keyword, page }) => {
    calls.push(`${keyword}${page}`);
    if (keyword === "B" && wait) {
      wait = false;
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return response([row(calls.length)]);
  });
  session.start("A", ["B", "C"]);
  const pending = session.load();
  await started;
  session.stop();
  release();
  await pending;
  await session.load();
  assert.deepEqual(calls, ["A1", "B1", "B1", "C1"]);
  assert.equal(session.pages, 3);
});
test("New installs, existing enabled configurations and legacy-only settings disable the experiment once while preserving other settings", async () => {
  for (const saved of [
    {},
    { biliSearchLensSettings: { enabled: true, fillPages: true } },
    {
      lensSettingsV2: {
        version: 2,
        modules: { search: true, tools: false },
        search: { fillPages: true, exclusions: "抽奖", relevanceVersion: 1 },
        downloads: { concurrent: 3 },
      },
    },
  ]) {
    const storage = {
      get: async () => structuredClone(saved),
      set: async (change) => Object.assign(saved, structuredClone(change)),
    };
    const value = await settings.load(storage);
    assert.equal(value.modules.search, false);
    assert.equal(value.search.fillPages, false);
    assert.equal(value.searchExperienceVersion, 1);
    if (saved.lensSettingsV2)
      assert.equal(saved.lensSettingsV2.searchExperienceVersion, 1);
    if (value.search.exclusions) {
      assert.equal(value.search.exclusions, "抽奖");
      assert.equal(value.downloads.concurrent, 3);
      assert.equal(value.modules.tools, false);
    }
    value.modules.search = true;
    value.search.fillPages = true;
    await settings.save(value, storage);
    assert.equal((await settings.load(storage)).modules.search, true);
    assert.equal((await settings.load(storage)).search.fillPages, true);
  }
});
test("Independent search retains clue-free Chinese and unrelated candidates instead of inheriting experimental rejection", async () => {
  const session = new Session(async () =>
    response([
      row(1),
      row(2, "GPT6.1实测"),
      row(3, "终末地基建"),
      row(4, "猫咪日常"),
    ]),
  );
  session.start("终末地基建");
  await session.load();
  assert.equal(session.selected().length, 4);
  assert.equal(session.selected("uncertain").length, 3);
  assert.equal(session.selected("matched")[0].bvid, row(3).bvid);
  session.toggleHidden(row(1).bvid);
  assert.equal(session.selected().length, 3);
  assert.equal(session.selected("hidden")[0].hiddenReason, "本次手动隐藏");
  session.toggleHidden(row(1).bvid);
  assert.equal(session.selected().length, 4);
  assert.equal(session.selected("all", "猫咪").length, 3);
  assert.equal(session.selected("hidden", "猫咪").length, 1);
  assert.throws(() => session.selected("all", '"缺右引号'));
});
test("Query variants share one stable deduplicated pool and independent cursors, allowing more than the legacy five-page limit", async () => {
  const calls = [];
  const session = new Session(async (message) => {
    calls.push(message);
    return {
      rows: [
        row(1),
        row(message.page * 10 + (message.keyword === "副查询" ? 1 : 0)),
      ],
      totalPages: 8,
      rawCount: 2,
    };
  });
  session.start("主查询", ["副查询", "主查询"], "pubdate");
  for (let i = 0; i < 8; i++) await session.load();
  assert.equal(calls.length, 16);
  assert.equal(session.pool.length, 17);
  assert.equal(new Set(session.pool.map((r) => r.bvid)).size, 17);
  assert.equal(session.hasMore, false);
  assert.deepEqual(
    calls.slice(0, 4).map((c) => [c.keyword, c.page, c.order]),
    [
      ["主查询", 1, "pubdate"],
      ["副查询", 1, "pubdate"],
      ["主查询", 2, "pubdate"],
      ["副查询", 2, "pubdate"],
    ],
  );
  const old = session.keyword;
  assert.throws(() => session.start("x", ["a", "b", "c"]));
  assert.equal(session.keyword, old);
});
test("Cancellation and a late response cannot pollute a replacement search; stopping preserves already committed rows", async () => {
  let finish;
  const session = new Session((message, { signal }) =>
    message.keyword === "旧"
      ? new Promise((resolve) => {
          finish = () => resolve(response([row(1)]));
          assert.equal(signal.aborted, false);
        })
      : Promise.resolve(response([row(2)])),
  );
  session.start("旧");
  const pending = session.load();
  session.start("新");
  await session.load();
  finish();
  await pending;
  assert.deepEqual(
    session.pool.map((r) => r.bvid),
    [row(2).bvid],
  );
  session.stop();
  assert.equal(session.pool.length, 1);
  assert.equal(session.hasMore, true);
});
test("Failed pages keep their cursor for retry, duplicate-only pages do not imply exhaustion, empty responses do", async () => {
  let fail = true;
  const calls = [],
    session = new Session(async (message) => {
      calls.push(message.page);
      if (fail) throw new Error("风控");
      return {
        ...response(message.page < 3 ? [row(1)] : []),
        totalPages: undefined,
      };
    });
  session.start("终末地基建");
  await session.load();
  assert.match(session.error, /风控/);
  fail = false;
  await session.load();
  await session.load();
  assert.equal(session.hasMore, true);
  await session.load();
  assert.equal(session.hasMore, false);
  assert.deepEqual(calls, [1, 1, 2, 3]);
  assert.equal(session.pool.length, 1);
});
test("Pool/request bounds are enforced and metadata enrichment cannot auto-hide a result", async () => {
  const session = new Session(async (message) => ({
    rows: Array.from({ length: 50 }, (_, n) => row(message.page * 100 + n)),
    rawCount: 50,
  }));
  session.start("GPT6.1");
  for (let i = 0; i < 30; i++) await session.load();
  assert.equal(session.pool.length, LIMIT);
  assert.equal(session.pages, 20);
  assert.equal(session.hasMore, false);
  const id = session.pool[0].bvid;
  session.updateTags(id, [null, "GPT 6.1"]);
  assert.equal(session.pool[0].clue, "matched");
  assert.equal(session.selected().length, LIMIT);
});
test("Independent search API validates page/order/keyword and normalizes safe fields with cancellation options", async () => {
  const api = new Api(async () => {});
  let options;
  api.request = async (path, params, passed) => {
    assert.equal(path, "/x/web-interface/wbi/search/type");
    assert.equal(params.page_size, 20);
    assert.equal(params.keyword, "终末地基建");
    assert.equal(params.page, 6);
    options = passed;
    return {
      result: [
        {
          bvid: row(1).bvid,
          title: "<em>终末地</em><img src=x>基建",
          pic: "javascript:alert(1)",
          type: "video",
          play: 123,
          video_review: 7,
        },
      ],
      numPages: 100,
    };
  };
  const signal = new AbortController().signal;
  const data = await api.searchPage(" 终末地基建 ", 6, "click", {
    signal,
    token: "test",
  });
  assert.equal(data.rows[0].title, "终末地基建");
  assert.equal(data.rows[0].pic, "");
  assert.equal(data.rawCount, 1);
  assert.equal(options.signed, true);
  assert.equal(options.signal, signal);
  for (const args of [
    ["x", 0, "click"],
    ["x", 21, "click"],
    ["x", 1.5, "click"],
    ["x", 1, "scores"],
    ["", 1, "click"],
    [{}, 1, "click"],
  ])
    await assert.rejects(api.searchPage(...args), /范围/);
});
