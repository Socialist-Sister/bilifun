const assert = require("node:assert/strict"),
  { test } = require("node:test"),
  { Store, Client, KEY, TTL } = require("../extension/pagination.js");
global.LensRefill = require("../extension/refill.js");
const scope = "a".repeat(64),
  other = "b".repeat(64),
  id = (n) => `BV1page${String(n).padStart(6, "0")}`;
function storage() {
  let data = {};
  return {
    get: async () => structuredClone(data),
    set: async (value) => {
      data = structuredClone(value);
    },
  };
}
test("First owning page survives repeat claims, back navigation and a fresh worker store", async () => {
  const memory = storage(),
    first = new Store(memory);
  await first.run(1, scope, 1);
  await first.run(1, scope, 1, [id(1), "av1"]);
  const restarted = new Store(memory);
  assert.deepEqual(await restarted.run(1, scope, 2, [id(1), "av1", id(2)]), {
    [id(1)]: 1,
    av1: 1,
    [id(2)]: 2,
  });
  assert.equal((await restarted.run(1, scope, 1))[id(1)], 1);
});
test("Tabs are isolated; new search scope invalidates old claims and resets owners", async () => {
  const store = new Store(storage());
  await store.run(1, scope, 1);
  await store.run(1, scope, 1, [id(1)]);
  assert.deepEqual(await store.run(2, scope, 2), {});
  assert.deepEqual(await store.run(1, other, 1), {});
  await assert.rejects(store.run(1, scope, 1, [id(1)]), /变更/);
});
test("Concurrent page claims are serialized without losing IDs or reassigning owners", async () => {
  const store = new Store(storage());
  await store.run(1, scope, 1);
  await Promise.all([
    store.run(1, scope, 1, [id(1)]),
    store.run(1, scope, 2, [id(1), id(2)]),
  ]);
  assert.deepEqual(await store.run(1, scope, 2), { [id(1)]: 1, [id(2)]: 2 });
});
test("Closing tabs and idle expiry clear only the appropriate records", async () => {
  let now = 1;
  const memory = storage(),
    store = new Store(memory, () => now);
  await store.run(1, scope, 1);
  await store.run(2, scope, 1);
  await store.remove(1);
  await assert.rejects(store.run(1, scope, 1), /关闭/);
  assert.deepEqual(Object.keys((await memory.get())[KEY]), ["2"]);
  now += TTL + 1;
  await store.run(3, scope, 1);
  assert.deepEqual(Object.keys((await memory.get())[KEY]), ["3"]);
  for (let tab = 4; tab <= 24; tab++) await store.run(tab, scope, 1);
  const tabs = (await memory.get())[KEY];
  assert.equal(Object.keys(tabs).length, 20);
  assert.ok(tabs[24]);
});
test("Ledger rejects unbounded and invalid messages and caps identifiers without partial writes", async () => {
  const memory = storage(),
    store = new Store(memory);
  await store.run(1, scope, 1);
  for (const args of [
    [-1, scope, 1],
    [1, "raw keyword", 1],
    [1, scope, 998],
    [1, scope, 1, ["https://evil.test"]],
    [1, scope, 1, Array(201).fill(id(1))],
  ])
    await assert.rejects(store.run(...args), /格式/);
  for (let start = 0; start < 10000; start += 200)
    await store.run(
      1,
      scope,
      1,
      Array.from({ length: 200 }, (_, n) => id(start + n)),
    );
  await assert.rejects(store.run(1, scope, 2, [id(10001)]), /上限/);
  assert.equal(Object.keys(await store.run(1, scope, 1)).length, 10000);
  await store.run(2, scope, 1);
  for (let start = 0; start < 10000; start += 200)
    await store.run(
      2,
      scope,
      1,
      Array.from({ length: 200 }, (_, n) => id(start + n)),
    );
  await store.run(3, scope, 1);
  await store.run(3, scope, 1, [id(1)]);
  const tabs = (await memory.get())[KEY];
  assert.ok(!tabs[1]);
  assert.ok(tabs[2] && tabs[3]);
});
const url = (page, order = "totalrank") =>
  `https://search.bilibili.com/all?keyword=贾队长&page=${page}&order=${order}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("Client reads ownership per route; only other pages are blocked; late reads cannot corrupt navigation", async () => {
  const waiting = [],
    client = new Client(
      () => new Promise((resolve) => waiting.push(resolve)),
      () => {},
    );
  client.prepare(url(1), 4, {}, false);
  client.prepare(url(2), 4, {}, false);
  waiting[1]({ [id(1)]: 1, [id(2)]: 2 });
  await tick();
  waiting[0]({ [id(3)]: 1 });
  await tick();
  assert.ok(client.blocked(id(1)));
  assert.ok(!client.blocked(id(2)));
  assert.ok(!client.owner(id(3)));
});
test("Client scope responds to query rules, server order and full page size", async () => {
  const calls = [],
    client = new Client(
      async (message) => {
        calls.push(message);
        return {};
      },
      () => {},
    );
  client.prepare(url(1), 4, { mode: "related" }, false);
  await tick();
  client.prepare(url(1), 4, { mode: "related" }, false);
  await tick();
  assert.equal(calls.length, 1);
  client.prepare(url(1, "click"), 4, { mode: "related" }, false);
  await tick();
  client.prepare(url(1, "click"), 4, { mode: "all" }, false);
  await tick();
  client.prepare(url(1, "click"), 8, { mode: "all" }, false);
  await tick();
  assert.equal(calls.length, 4);
});
test("A failed storage read stops claiming and surfaces an error without an endless retry", async () => {
  let calls = 0;
  const client = new Client(
    async () => {
      calls++;
      throw new Error("Storage unavailable");
    },
    () => {},
  );
  client.prepare(url(1), 4, {}, false);
  await tick();
  client.commit([id(1)]);
  client.prepare(url(1), 4, {}, false);
  await tick();
  assert.equal(calls, 1);
  assert.equal(client.pending, false);
  assert.match(client.error, /Storage/);
});
