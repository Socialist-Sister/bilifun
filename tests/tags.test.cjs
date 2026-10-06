const { test } = require("node:test");
const assert = require("node:assert/strict");
const Api = require("../extension/api.js");
const Tags = require("../extension/tags.js");
const core = require("../extension/core.js");
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const makeStorage = (rows = []) => {
  const data = { lensVideoTags: rows };
  return {
    data,
    get: async () => data,
    set: async (value) => Object.assign(data, structuredClone(value)),
  };
};
test("Actual tag endpoint accepts BV/av IDs and normalizes bounded tag names", async () => {
  const urls = [],
    api = new Api(async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          code: 0,
          data: [
            { tag_name: " 贾队长 " },
            { tag_name: "贾队长" },
            { tag_name: "高能" },
          ],
        }),
      );
    });
  assert.deepEqual(await api.tags("BV1UftJ6rE4o"), ["贾队长", "高能"]);
  await api.tags("av123");
  assert.equal(new URL(urls[0]).pathname, "/x/tag/archive/tags");
  assert.equal(new URL(urls[1]).searchParams.get("aid"), "123");
  await assert.rejects(api.tags("https://evil.example/"), /ID/);
});
test("Malformed tag responses and risk controls are failures, not empty successful evidence", async () => {
  for (const data of [{}, [{ unrelated: "x" }], [null]]) {
    const api = new Api(
      async () => new Response(JSON.stringify({ code: 0, data })),
    );
    await assert.rejects(api.tags("BV1UftJ6rE4o"), /格式/);
  }
  let calls = 0;
  const api = new Api(async () => {
    calls++;
    return new Response(JSON.stringify({ code: -412 }));
  });
  await assert.rejects(api.tags("BV1UftJ6rE4o"), /风控/);
  assert.equal(calls, 1);
});
test("Tag-only relevance rescues the user's title in cautious and strict modes", () => {
  for (const mode of ["related", "all", "any"]) {
    const card = {
      title: "舍不得的他他他",
      tags: ["高能", "舞台秀", "贾队长"],
    };
    const result = core.evaluateVideo(
      card,
      core.compileRules("贾队长", "", mode),
      { useVideoTags: true },
    );
    assert.equal(result.keep, true, mode);
    if (mode === "related") assert.equal(result.relevance, "relevant");
    const lateTag = {
      title: "舍不得的他他他",
      tags: [...Array(49).fill("其他标签"), "贾队长"],
    };
    assert.equal(
      core.evaluateVideo(lateTag, core.compileRules("贾队长", "", mode), {
        useVideoTags: true,
      }).keep,
      true,
    );
  }
  assert.equal(
    core.evaluateVideo(
      { title: "舍不得的他他他", tags: ["贾队长"] },
      core.compileRules("贾队长", "", "all"),
      { useVideoTags: false },
    ).keep,
    false,
  );
});
test("Tag matches do not override explicit blocks, exclusions or time limits", () => {
  const rules = core.compileRules("贾队长", "抽奖", "all"),
    card = {
      title: "舍不得的他他他",
      tags: ["贾队长"],
      uid: "123",
      duration: 10,
    };
  assert.equal(
    core.evaluateVideo({ ...card, title: "抽奖" }, rules, {
      useVideoTags: true,
    }).keep,
    false,
  );
  assert.equal(
    core.evaluateVideo(card, rules, {
      useVideoTags: true,
      blockedUploaders: ["123"],
    }).keep,
    false,
  );
  assert.equal(
    core.evaluateVideo(card, rules, { useVideoTags: true, minDuration: 20 })
      .keep,
    false,
  );
  const tagExcluded = core.evaluateVideo(
    card,
    core.compileRules("贾队长", "高能", "all"),
    { useVideoTags: true },
  );
  assert.equal(tagExcluded.keep, true); // Exclusions still target the title; tags rescue inclusions only.
});
test("Strict multiword matching can use both title and tags without manufacturing phrases", () => {
  const card = { title: "高能合集", tags: ["贾队长", "影视"] };
  assert.equal(
    core.evaluateVideo(card, core.compileRules("高能 贾队长", "", "all"), {
      useVideoTags: true,
    }).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo(card, core.compileRules('"高能 贾队长"', "", "all"), {
      useVideoTags: true,
    }).keep,
    false,
  );
  const blocked = core.evaluateVideo(
    { title: "抽奖" },
    core.compileRules("贾队长", "抽奖", "all"),
  );
  assert.equal(blocked.queryMismatch, undefined);
});
test("Tag cache survives service recreation, honors TTL and ignores invalid stored rows", async () => {
  const storage = makeStorage([
    { id: "BV1UftJ6rE4o", time: Date.now() - 86400001, tags: ["旧标签"] },
    { id: "invalid", time: Date.now(), tags: ["x"] },
  ]);
  let calls = 0;
  const fetch = async () => {
    calls++;
    return ["贾队长"];
  };
  const first = new Tags(fetch, storage);
  assert.deepEqual(await first.get("BV1UftJ6rE4o", "doc:1"), ["贾队长"]);
  assert.deepEqual(
    await new Tags(fetch, storage).get("BV1UftJ6rE4o", "doc:2"),
    ["贾队长"],
  );
  assert.equal(calls, 1);
  assert.equal(storage.data.lensVideoTags.length, 1);
});
test("Global tag queue limits concurrency and cancels a queued caller before fetching", async () => {
  let active = 0,
    maximum = 0,
    calls = 0;
  const releases = [];
  const service = new Tags(async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    return [];
  }, makeStorage());
  const a = service.get("av1", "page-a:request"),
    b = service.get("av2", "page-b:request"),
    c = service.get("av3", "page-c:request");
  const rejected = assert.rejects(c, /取消/);
  await tick();
  service.cancel("page-c:request");
  await rejected;
  releases.splice(0).forEach((release) => release());
  await Promise.all([a, b]);
  assert.equal(maximum, 2);
  assert.equal(calls, 2);
  let unlock;
  const pending = service.get(
    "av4",
    "page-d:request",
    () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
  );
  const earlyCancel = assert.rejects(pending, /取消/);
  service.cancel("page-d:request");
  unlock();
  await earlyCancel;
  assert.equal(calls, 2); // Cancellation while checking permission cannot start a later fetch.
});
test("Clearing tags cancels active work and prevents late results repopulating the cache", async () => {
  const storage = makeStorage();
  let release;
  const service = new Tags(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return ["迟到"];
  }, storage);
  const operation = service.get("av1", "active"),
    rejected = assert.rejects(operation, /取消/);
  await tick();
  await service.clear();
  release();
  await rejected;
  await tick();
  assert.deepEqual(storage.data.lensVideoTags, []);
  assert.equal(service.cache.size, 0);
});
test("Cache has a bounded 300-video capacity and rejects invalid IDs", async () => {
  const service = new Tags(async () => [], makeStorage());
  for (let n = 1; n <= 302; n++) await service.get("av" + n, "doc:" + n);
  assert.equal(service.cache.size, 300);
  assert.equal(service.cache.has("av1"), false);
  await assert.rejects(service.get("bad", "token"), /参数/);
});
