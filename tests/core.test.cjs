const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compileRules, evaluate, parseQuery } = require("../extension/core.js");
const Adapter = require("../extension/adapter.js");

test("strict matching rejects partial and irrelevant results", () => {
  const rules = compileRules("机械键盘 静音");
  assert.equal(evaluate("静音机械键盘横评", rules).keep, true);
  assert.equal(evaluate("机械键盘开箱", rules).keep, false);
  assert.match(evaluate("机械键盘开箱", rules).reason, /静音/);
  assert.equal(evaluate("今天的猫猫", rules).keep, false);
});
test("any mode is relaxed while exclusions always win", () => {
  const rules = compileRules("机械键盘 静音", "抽奖", "any");
  assert.equal(evaluate("机械键盘开箱", rules).keep, true);
  assert.equal(evaluate("静音机械键盘抽奖", rules).keep, false);
  assert.equal(evaluate("猫猫", rules).keep, false);
});
test("quoted phrases stay together; inline exclusions are supported", () => {
  assert.deepEqual(parseQuery('"linear algebra" Python -"short video"'), {
    include: ["linear algebra", "Python"],
    exclude: ["short video"],
    error: null,
  });
  const rules = compileRules('"linear algebra" -short');
  assert.equal(evaluate("LINEAR ALGEBRA tutorial", rules).keep, true);
  assert.equal(evaluate("linear intro to algebra", rules).keep, false);
  assert.equal(evaluate("linear algebra short", rules).keep, false);
});
test("normalization handles width, case and repeated whitespace without splitting C++", () => {
  assert.equal(
    evaluate("Ｐｙｔｈｏｎ 入门", compileRules("Python")).keep,
    true,
  );
  assert.equal(
    evaluate("linear   algebra", compileRules('"linear algebra"')).keep,
    true,
  );
  assert.equal(evaluate("C++ 教程", compileRules("C++")).keep, true);
  assert.deepEqual(parseQuery("Python python ＰＹＴＨＯＮ").include, [
    "Python",
  ]);
});
test("empty inclusion can act as an exclusion-only filter", () => {
  assert.equal(evaluate("任意视频", compileRules("")).keep, true);
  assert.equal(evaluate("抽奖", compileRules("", "抽奖")).keep, false);
});
test("invalid syntax preserves all results instead of silently hiding videos", () => {
  for (const query of ['"unclosed', '"word"next', 'word"quote', "-", '""']) {
    const rules = compileRules(query);
    assert.ok(rules.error);
    assert.equal(evaluate("任何视频", rules).keep, true);
  }
  assert.equal(evaluate("任何视频", compileRules("Python", '"bad')).keep, true);
});
test("unreadable titles remain visible", () => {
  const result = evaluate("", compileRules("机械键盘"));
  assert.equal(result.keep, true);
  assert.equal(result.unknown, true);
});
test("URL keywords are decoded and missing or invalid URLs are harmless", () => {
  assert.equal(
    Adapter.keywordFromUrl(
      "https://search.bilibili.com/video?keyword=%E9%9D%99%E9%9F%B3+Python",
    ),
    "静音 Python",
  );
  assert.equal(Adapter.keywordFromUrl("https://search.bilibili.com/"), "");
  assert.equal(Adapter.keywordFromUrl("not a URL"), "");
});
