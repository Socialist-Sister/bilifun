const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");
const settings = require("../extension/settings.js");
const rule = (query = "gpt6.1", excludes = "", options = {}) =>
  core.compileRules(query, excludes, "related", options);
test("Abbreviated Sol queries recognize full model names from the user's screenshots", () => {
  for (const query of [
    "6.1sol",
    "6.1 Sol",
    "6.1-sol",
    "６．１ＳＯＬ",
    '"6.1 Sol"',
  ])
    for (const title of [
      "GPT-6.1 Sol 大战 Opus 5.5：到底该选谁？",
      "GPT 6.1 Sol：前端上有提升，但是前端上有提升不太可能",
      "【GPT6】GPT6.1-sol发布！简单测试神了还是区了？",
      "OpenAI 发布 GPT-6.1 Sol 和 Dots【AI早报 2026-09-30】",
      "ChatGPT 6.1 SOL 新实测",
      "6.1 Sol 前端能力",
    ])
      assert.equal(
        core.evaluate(title, rule(query)).relevance,
        "relevant",
        query + " / " + title,
      );
});
test("Abbreviated query metadata rescue respects versions, unrelated subjects and explicit blocks", () => {
  const rules = rule("6.1sol");
  for (const query of ["6.1sol", "6.1 Sol", "6.1-sol"])
    for (const title of [
      "GPT6.10 Sol实测",
      "GPT5.2 Sol实测",
      "猫咪日常",
      "Qwen3.8-Max上线",
      "2026.1sol音乐合集",
    ])
      assert.equal(
        core.evaluate(title, rule(query)).keep,
        false,
        query + " / " + title,
      );
  assert.equal(
    core.evaluateVideo({ title: "新的前端体验", tags: ["GPT-6.1 Sol"] }, rules)
      .keep,
    true,
  );
  assert.equal(
    core.evaluateVideo(
      { title: "新模型体验", description: "使用 GPT 6.1 Sol" },
      rules,
    ).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo({ title: "GPT-6.1 Sol 抽奖" }, rule("6.1sol", "抽奖"))
      .keep,
    false,
  );
  assert.equal(
    core.evaluateVideo({ title: "GPT-6.1 Sol 实测", uid: "7" }, rules, {
      blockedUploaders: ["7"],
    }).keep,
    false,
  );
  assert.equal(core.evaluate("OpenAI新模型", rules).relevance, "uncertain");
  assert.equal(
    core.evaluate("GPT-6.1 实测", rule("6.1")).relevance,
    "relevant",
  );
  assert.equal(core.evaluate("OpenAI新模型", rule("6.1")).keep, false);
  assert.deepEqual(rule("Opus 6.1 Sol").relevance.models, [
    { family: "opus", version: "6.1" },
  ]);
});
test("Cautious search retains the model spellings and abbreviation supplied by the user", () => {
  for (const query of ["gpt6.1", "gpt 6.1", "GPT-6.1", '"GPT 6.1"'])
    for (const title of [
      "GPT6.1 Sol发布",
      "GPT 6.1 SOL 实测",
      "GPT-6.1 Sol评测",
      "GPT—6.1体验",
      "ＧＰＴ－６．１发布",
      "ChatGPT 6.1 测试",
      "6.1sol发布",
      "6.1 Sol 前端能力",
    ]) {
      const result = core.evaluate(title, rule(query));
      assert.equal(result.keep, true, query + " / " + title);
      assert.equal(result.relevance, "relevant");
    }
});
test("OpenAI and broad model titles stay uncertain and visible", () => {
  for (const title of [
    "OpenAI新模型来了",
    "GPT-6 Astra体验",
    "OpenAI DevDay速览",
  ]) {
    const result = core.evaluate(title, rule());
    assert.equal(result.keep, true, title);
    assert.equal(result.relevance, "uncertain", title);
  }
});
test("Existing descriptions and tags can rescue titles without literal keywords", () => {
  assert.equal(
    core.evaluateVideo(
      { title: "家常红烧肉教程", description: "用 GPT-6.1 生成食谱和步骤" },
      rule(),
    ).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo(
      { title: "我被这个效果惊到了", tags: ["GPT 6.1", "人工智能"] },
      rule(),
    ).relevance,
    "relevant",
  );
  assert.equal(
    core.evaluateVideo(
      { title: "全新体验", description: "GPT 6.1" },
      core.compileRules("gpt6.1", "", "all"),
    ).keep,
    false,
  );
});
test("Clearly different topics and explicit different model versions have explanations", () => {
  for (const title of [
    "家常红烧肉做法",
    "今天又被猫猫叫醒了",
    "王者荣耀上分技巧",
    "GPT6.10发布评测",
    "GPT5.2发布实测",
  ]) {
    const result = core.evaluate(title, rule());
    assert.equal(result.keep, false, title);
    assert.equal(result.relevance, "unrelated");
    assert.ok(result.reason);
  }
  assert.equal(core.evaluate("GPT6.1和GPT6.10对比", rule()).keep, true);
  assert.equal(core.evaluate("GPT5.2与新模型对比", rule()).keep, true);
});
test("A distinct named model alone is excluded but comparison or target context rescues it", () => {
  for (const title of [
    "Qwen3.8-Max上线",
    "上新 DeepSeek-v4-flash",
    "Gemini4 Pro发布",
  ])
    assert.equal(core.evaluate(title, rule()).keep, false, title);
  assert.equal(core.evaluate("Qwen3.8与新模型对比", rule()).keep, false);
  assert.equal(core.evaluate("OpenAI对Qwen3.8的回应", rule()).keep, true);
  assert.equal(
    core.evaluateVideo(
      { title: "Qwen3.8-Max上线", description: "对比 GPT-6.1 Sol" },
      rule(),
    ).keep,
    true,
  );
  assert.equal(core.evaluate("DeepSeek-v4实测", rule("deepseek4")).keep, true);
});
test("Bare version numbers do not prove model relevance and preserve decimal boundaries", () => {
  assert.notEqual(
    core.evaluate("RTX5090 驱动6.1 更新", rule()).relevance,
    "relevant",
  );
  assert.notEqual(
    core.evaluate("2026.1sol音乐合集", rule()).relevance,
    "relevant",
  );
  assert.equal(core.evaluate("GPT 6.10 发布", rule("gpt 6.1")).keep, false);
  assert.equal(core.evaluate("GPT 6.1.1 修复", rule()).keep, true);
});
test("Other topics use the same cautious policy instead of a GPT-only bypass", () => {
  assert.equal(
    core.evaluate("机械键盘青轴开箱", rule("机械键盘 静音")).keep,
    true,
  );
  assert.equal(core.evaluate("手机发布会", rule("iphone17")).keep, false);
  assert.equal(core.evaluate("苹果发布会", rule("iphone17")).keep, true);
  assert.equal(
    core.evaluate("iPhone-17 Pro实测", rule("iphone17")).relevance,
    "relevant",
  );
  assert.equal(core.evaluate("家常红烧肉做法", rule("iphone17")).keep, false);
  assert.equal(core.evaluate("Python自动化编程", rule()).keep, false);
  assert.equal(
    core.evaluate("普通生活记录", rule("没有词典线索的主题")).keep,
    false,
  );
});
test("No evidence and nonmatching tags cannot bypass arbitrary Chinese searches", () => {
  for (const query of ["贾队长", "没有词典线索的主题", "gpt6.1"])
    for (const title of ["普通生活记录", "我被这个效果惊到了", "猫咪日常"])
      assert.equal(
        core.evaluateVideo({ title, tags: ["猫咪", "日常"] }, rule(query)).keep,
        false,
        query + " / " + title,
      );
  assert.equal(
    core.evaluateVideo(
      { title: "舍不得的他他他", tags: ["贾队长"] },
      rule("贾队长"),
    ).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo({ title: "OpenAI新模型", tags: ["科技"] }, rule()).keep,
    true,
  );
  for (const title of [
    "RTX5090显卡评测",
    "AI工具盘点",
    "Python自动化编程",
    "安卓手机发布会",
  ])
    assert.equal(core.evaluate(title, rule()).keep, false, title);
});
test("Explicit exclusions, uploader blocks and promotion preferences still apply", () => {
  assert.equal(
    core.evaluate("GPT-6.1 Sol抽奖", rule("gpt6.1", "抽奖")).keep,
    false,
  );
  assert.equal(core.evaluate("GPT-6.1体验", rule("", "gpt6.1")).keep, false);
  assert.equal(
    core.evaluateVideo({ title: "OpenAI新模型", uid: 7 }, rule(), {
      blockedUploaders: ["7"],
    }).keep,
    false,
  );
  assert.equal(
    core.evaluateVideo({ title: "GPT6.1", promoted: true }, rule(), {
      hidePromotions: true,
    }).keep,
    false,
  );
  assert.equal(
    core.evaluateVideo({ title: "家常菜", uid: 7 }, rule(), {
      allowedUploaders: ["7"],
    }).keep,
    true,
  );
});
test("Synonyms supply relevance clues without changing strict mode or phrase parsing", () => {
  const options = { synonyms: [["AI", "人工智能"]] };
  assert.equal(
    core.evaluate("人工智能新工具", rule("AI", "", options)).keep,
    true,
  );
  assert.equal(
    core.evaluate("GPT 6.1", core.compileRules("gpt6.1")).keep,
    false,
  );
  assert.equal(core.evaluate("我被惊到了", rule('"gpt6.1')).keep, true);
  assert.equal(core.evaluate("", rule()).unknown, true);
});
test("Unknown or malformed metadata never becomes required and stays bounded", () => {
  assert.doesNotThrow(() =>
    core.evaluate("constructor4 介绍", rule("constructor3")),
  );
  assert.equal(
    core.evaluateVideo(
      { title: "无提示标题", description: null, tags: [null, {}, "OpenAI"] },
      rule(),
    ).keep,
    true,
  );
  assert.equal(
    core.evaluateVideo({ title: "无提示标题" }, rule()).relevance,
    "unrelated",
  );
});
test("Old strict defaults migrate once while preserving user settings and subsequent strict choice", async () => {
  const stored = {
    lensSettingsV2: {
      version: 2,
      modules: { search: false },
      search: { mode: "all", exclusions: "抽奖", blockedUploaders: ["7"] },
    },
  };
  const storage = {
    get: async () => structuredClone(stored),
    set: async (change) => Object.assign(stored, structuredClone(change)),
  };
  const value = await settings.load(storage);
  assert.equal(value.search.mode, "related");
  assert.equal(value.modules.search, false);
  assert.equal(value.search.exclusions, "抽奖");
  assert.deepEqual(value.search.blockedUploaders, ["7"]);
  assert.equal(stored.lensSettingsV2.search.relevanceVersion, 1);
  value.search.mode = "all";
  await settings.save(value, storage);
  assert.equal((await settings.load(storage)).search.mode, "all");
});
test("Explicit any mode remains a choice and new installs default to cautious search", async () => {
  assert.equal(settings.defaults.search.mode, "related");
  const value = await settings.load({
    get: async () => ({
      lensSettingsV2: { version: 2, search: { mode: "any" } },
    }),
  });
  assert.equal(value.search.mode, "any");
});
