const { test } = require("node:test"),
  assert = require("node:assert/strict");
const refill = require("../extension/refill.js"),
  Api = require("../extension/api.js"),
  settings = require("../extension/settings.js");
const source =
  "https://search.bilibili.com/video?keyword=%E8%B4%BE%E9%98%9F%E9%95%BF&page=8&order=stow&duration=2&tids=22&pubtime_begin_s=1700000000&order_sort=1&from_source=tracking";
test("Refill context preserves source page, keyword, sort and filters without tracking parameters", () => {
  assert.deepEqual(refill.context(source, 42), {
    keyword: "贾队长",
    page: 8,
    order: "stow",
    pageSize: 42,
    filters: {
      duration: 2,
      tids: 22,
      pubtime_begin_s: 1700000000,
      order_sort: 1,
    },
  });
  assert.equal(
    refill.context("https://search.bilibili.com/all?keyword=gpt6.1").order,
    "totalrank",
  );
  for (const url of [
    "https://evil.example/video?keyword=x",
    "https://search.bilibili.com/bangumi?keyword=x",
    source.replace("page=8", "page=1.5"),
    source.replace("duration=2", "duration=9"),
    source.replace("order=stow", "order=unknown"),
  ])
    assert.throws(() => refill.context(url, 42));
  assert.throws(() => refill.context(source, 51));
});
test("Public search rows are bounded, safe links and pictures are rebuilt, and existing tags carry evidence", () => {
  const data = refill.normalizePage({
    numPages: 12,
    pagesize: 42,
    result: [
      {
        type: "video",
        bvid: "BV1fill000007",
        aid: 7,
        title: "<em>舍不得</em>的他他他 &amp; 新片",
        description: "<b>公开简介</b>",
        tag: "舞台秀,贾队长",
        author: "UP",
        mid: 123,
        duration: "01:20",
        play: 12000,
        video_review: 107,
        pubdate: 1700000000,
        typeid: 22,
        pic: "//i0.hdslb.com/bfs/archive/pic.jpg",
      },
      { bvid: "https://evil.example", title: "bad" },
    ],
  });
  assert.equal(data.rows.length, 1);
  const row = data.rows[0];
  assert.equal(row.title, "舍不得的他他他 & 新片");
  assert.deepEqual(row.tags, ["舞台秀", "贾队长"]);
  assert.equal(row.duration, 80);
  assert.equal(row.danmaku, 107);
  assert.equal(row.pubdate, 1700000000);
  assert.deepEqual(row.highlights, ["舍不得"]);
  assert.equal(row.uid, "123");
  assert.deepEqual(row.aliases, ["BV1fill000007", "av7"]);
  assert.equal(row.url, "https://www.bilibili.com/video/BV1fill000007");
  assert.equal(row.pic, "https://i0.hdslb.com/bfs/archive/pic.jpg");
  for (const pic of [
    "javascript:alert(1)",
    "https://i0.hdslb.com.evil.example/pic",
    "https://user:secret@i0.hdslb.com/pic",
  ])
    assert.equal(
      refill.normalizePage({
        result: [{ bvid: "BV1fill000007", title: "x", pic }],
      }).rows[0].pic,
      "",
    );
  assert.throws(() => refill.normalizePage({ result: {} }));
  assert.throws(() =>
    refill.normalizePage({ result: new Array(101).fill({}) }),
  );
});
test("Refill uses bounded next pages, identical page size and abortable signed API requests", async () => {
  let query, signal;
  const api = new Api(async (url, init) => {
    query = new URL(url).searchParams;
    signal = init.signal;
    return new Response(
      JSON.stringify({
        code: 0,
        data: { pagesize: 42, numPages: 20, result: [] },
      }),
    );
  });
  api.signature = async (params) => new URLSearchParams(params).toString();
  const controller = new AbortController(),
    context = refill.context(source, 42);
  await api.refillPage(context, 9, { signal: controller.signal, token: "qa" });
  assert.equal(query.get("page"), "9");
  assert.equal(query.get("page_size"), "42");
  assert.equal(query.get("tids"), "22");
  assert.equal(query.get("order"), "stow");
  assert.equal(query.get("keyword"), "贾队长");
  assert.equal(query.has("from_source"), false);
  assert.equal(signal.aborted, false);
  assert.equal(api.controllers.size, 0);
  for (const page of [8, 12, 9.1])
    await assert.rejects(api.refillPage(context, page), /3 页/);
  controller.abort();
  await assert.rejects(
    api.refillPage(context, 9, {
      signal: controller.signal,
      token: "cancelled",
    }),
    /取消/,
  );
  assert.equal(api.controllers.size, 0);
});
test("Cross-page preference validates and migrates a saved disabled choice", async () => {
  assert.equal(settings.defaults.search.fillPages, false);
  assert.equal(
    settings.validate({ version: 2, search: { fillPages: false } }).search
      .fillPages,
    false,
  );
  assert.equal(
    (
      await settings.load({
        get: async () => ({ biliSearchLensSettings: { fillPages: false } }),
        set: async () => {},
      })
    ).search.fillPages,
    false,
  );
});
