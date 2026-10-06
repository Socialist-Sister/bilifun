const { test } = require("node:test"),
  assert = require("node:assert/strict");
const Rpc = require("../extension/rpc.js"),
  Api = require("../extension/api.js");
require("../extension/media.js");
test("Bounded RPC returns success and surfaces worker or transport errors", async () => {
  assert.equal(
    await Rpc.createClient(async () => ({ ok: true, result: 42 })).request({
      op: "view",
    }),
    42,
  );
  await assert.rejects(
    Rpc.createClient(async () => ({ ok: false, error: "视频不存在" })).request({
      op: "view",
    }),
    /不存在/,
  );
  await assert.rejects(
    Rpc.createClient(async () => {
      throw new Error("Connection closed");
    }).request({ op: "view" }),
    /closed/,
  );
});
test("A worker that never replies hits the page deadline and receives a cancellation token", async () => {
  const calls = [],
    client = Rpc.createClient((message) => {
      calls.push(message);
      return new Promise(() => {});
    });
  await assert.rejects(
    client.request(
      { op: "view", id: "av1", token: "lookup-1" },
      { timeout: 25 },
    ),
    /停止等待/,
  );
  assert.deepEqual(
    calls.map((message) => message.op),
    ["view", "cancelRequest"],
  );
  assert.equal(calls[1].token, "lookup-1");
});
test("User cancellation rejects promptly and a late success cannot replace the stopped result", async () => {
  let resolve;
  const calls = [],
    controller = new AbortController();
  const client = Rpc.createClient((message) => {
    calls.push(message);
    return message.op === "cancelRequest"
      ? Promise.resolve({ ok: true })
      : new Promise((done) => {
          resolve = done;
        });
  });
  const operation = client.request(
    { op: "view", token: "stopped" },
    { signal: controller.signal },
  );
  await Promise.resolve();
  const rejected = assert.rejects(operation, { name: "AbortError" });
  controller.abort();
  resolve({ ok: true, result: "late" });
  await rejected;
  assert.equal(
    calls.filter((message) => message.op === "cancelRequest").length,
    1,
  );
});
test("Already-cancelled reads do not dispatch the resource request", async () => {
  const calls = [],
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Rpc.createClient(async (message) => {
      calls.push(message);
    }).request(
      { op: "view", token: "not-started" },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(
    calls.map((message) => message.op),
    ["cancelRequest"],
  );
});
test("Metadata options propagate the request token and abort the actual API fetch", async () => {
  const api = new Api(
    (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      ),
  );
  const controller = new AbortController(),
    operation = api.view("BV1UftJ6rE4o", {
      token: "metadata",
      signal: controller.signal,
    });
  const rejected = assert.rejects(operation, /取消/);
  controller.abort();
  await rejected;
  assert.equal(api.controllers.size, 0);
});
test("Subtitle-list reads cancel during signing and during the actual player API fetch", async () => {
  let releaseSignature,
    fetched = 0;
  const api = new Api((_url, { signal }) => {
    fetched++;
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  api.signature = () =>
    new Promise((resolve) => {
      releaseSignature = resolve;
    });
  const signing = new AbortController(),
    first = api.player("BV1UftJ6rE4o", 1234, {
      signal: signing.signal,
      token: "player-sign",
    });
  const firstRejected = assert.rejects(first, /取消/);
  signing.abort();
  releaseSignature("bvid=BV1UftJ6rE4o&cid=1234");
  await firstRejected;
  assert.equal(fetched, 0);
  api.signature = async (params) => new URLSearchParams(params).toString();
  const fetching = new AbortController(),
    second = api.player("BV1UftJ6rE4o", 1234, {
      signal: fetching.signal,
      token: "player-fetch",
    });
  await Promise.resolve();
  const secondRejected = assert.rejects(second, /取消/);
  fetching.abort();
  await secondRejected;
  assert.equal(fetched, 1);
  assert.equal(api.controllers.size, 0);
});
