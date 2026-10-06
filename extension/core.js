/* Preserve positive relevance clues and model spelling variants.
 * Missing clues trigger tag verification rather than unconditional retention. */
/** @param {any} root */
(function (root) {
  "use strict";
  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
  }
  function unique(terms) {
    const seen = new Set();
    return terms.filter((term) => {
      const key = normalize(term);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const topics = {
    ai: [
      "gpt",
      "chatgpt",
      "openai",
      "open ai",
      "claude",
      "anthropic",
      "gemini",
      "deepseek",
      "qwen",
      "llama",
      "大模型",
      "语言模型",
      "人工智能",
      "生成式",
      "机器学习",
      "ai",
      "llm",
    ],
    code: [
      "python",
      "javascript",
      "typescript",
      "java",
      "c++",
      "编程",
      "代码",
      "程序开发",
      "软件开发",
      "前端",
      "后端",
    ],
    keyboard: [
      "机械键盘",
      "键盘",
      "keyboard",
      "keychron",
      "轴体",
      "青轴",
      "红轴",
      "茶轴",
    ],
    hardware: [
      "显卡",
      "主板",
      "cpu",
      "gpu",
      "rtx",
      "gtx",
      "装机",
      "硬件",
      "内存条",
    ],
    phone: ["iphone", "ipad", "手机", "安卓", "android", "redmi", "鸿蒙"],
    food: [
      "做菜",
      "菜谱",
      "美食",
      "红烧肉",
      "烹饪",
      "家常菜",
      "食谱",
      "面包",
      "蛋糕",
      "cooking",
      "recipe",
    ],
    pets: ["猫猫", "猫咪", "撸猫", "狗狗", "宠物", "养猫", "养狗", "萌宠"],
    games: [
      "游戏",
      "王者荣耀",
      "原神",
      "崩坏",
      "黑神话",
      "英雄联盟",
      "minecraft",
      "xbox",
      "playstation",
    ],
    music: ["音乐", "歌曲", "演唱", "翻唱", "钢琴", "吉他", "演奏", "music"],
    film: ["电影", "电视剧", "影视", "动漫", "动画", "番剧", "鬼畜"],
    sport: ["足球", "篮球", "健身", "跑步", "游泳", "乒乓球", "羽毛球"],
    finance: ["股市", "炒股", "股票", "基金", "理财", "财报", "期货"],
    travel: ["旅游", "旅行", "酒店", "景点", "出游", "自驾游"],
    learning: [
      "高考",
      "考研",
      "四六级",
      "雅思",
      "托福",
      "数学",
      "微积分",
      "线性代数",
    ],
  };
  const families = Object.assign(Object.create(null), { chatgpt: "gpt" });
  const modelTopics = Object.assign(Object.create(null), {
    gpt: "ai",
    claude: "ai",
    opus: "ai",
    sonnet: "ai",
    gemini: "ai",
    deepseek: "ai",
    qwen: "ai",
    llama: "ai",
    python: "code",
    java: "code",
    rtx: "hardware",
    gtx: "hardware",
    iphone: "phone",
    ipad: "phone",
  });
  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function identifierText(value) {
    return normalize(value).replace(/[‐‑‒–—−]/g, "-");
  }
  function modelsIn(value) {
    return [
      ...identifierText(value).matchAll(
        /(?<![a-z0-9])([a-z][a-z0-9]*?)[\s_-]*(?:v(?=\d))?(\d+(?:\.\d+)*)(?![\d.])/gu,
      ),
    ].map((match) => ({
      family: families[match[1]] || match[1],
      version: match[2],
    }));
  }
  function topicIds(text) {
    const result = Object.keys(topics).filter((topic) =>
      topics[topic].some((word) =>
        /[\u4e00-\u9fff]/u.test(word)
          ? text.includes(word)
          : new RegExp(`(?<![a-z0-9_])${escaped(word)}(?![a-z0-9_])`, "u").test(
              text,
            ),
      ),
    );
    for (const model of modelsIn(text))
      if (
        modelTopics[model.family] &&
        !result.includes(modelTopics[model.family])
      )
        result.push(modelTopics[model.family]);
    return result;
  }
  function compatibleVersion(a, b) {
    const left = a.split("."),
      right = b.split(".");
    return left
      .slice(0, Math.min(left.length, right.length))
      .every((part, index) => part === right[index]);
  }
  function versionMatches(candidate, target) {
    return (
      compatibleVersion(candidate, target) &&
      candidate.split(".").length >= target.split(".").length
    );
  }
  function relevanceProfile(terms, options) {
    const text = identifierText(terms.join(" "));
    const aliases = terms.flatMap(
      (term) =>
        (options.synonyms || []).find((group) =>
          group.some((word) => normalize(word) === normalize(term)),
        ) || [],
    );
    const models = modelsIn(text);
    // Recognize the user's abbreviated *query*, not just abbreviated titles.
    // Bare decimals and other named model families do not imply GPT.
    if (!models.length)
      for (const match of text.matchAll(
        /(?<![a-z0-9.])(\d+(?:\.\d+)+)[\s_-]*sol(?![a-z])/gu,
      ))
        models.push({ family: "gpt", version: match[1] });
    return {
      models,
      topics: topicIds(
        identifierText(
          [text, ...aliases, ...models.map((m) => m.family + m.version)].join(
            " ",
          ),
        ),
      ),
    };
  }
  function flexibleContains(text, word, wordBoundary = false) {
    const needle = identifierText(word),
      models = modelsIn(needle);
    if (models.length)
      return models.some((model) =>
        modelsIn(text).some(
          (item) =>
            item.family === model.family &&
            versionMatches(item.version, model.version),
        ),
      );
    const shortSol = /^(\d+(?:\.\d+)+)[\s_-]*sol$/.exec(needle);
    if (shortSol)
      return new RegExp(
        String.raw`(?<![\d.])${escaped(shortSol[1])}(?![\d.])[\s_-]*sol(?![a-z])`,
        "u",
      ).test(text);
    if (/^\d+(?:\.\d+)+$/.test(needle))
      return new RegExp(
        String.raw`(?<![\d.])${escaped(needle)}(?![\d.])`,
        "u",
      ).test(text);
    if (wordBoundary && /[a-z0-9]/i.test(needle))
      return new RegExp(
        `(?<![a-z0-9_])${escaped(needle)}(?![a-z0-9_])`,
        "u",
      ).test(text);
    return text.includes(needle);
  }
  /** Local evidence triage; target brand context is a clue, broad categories alone are not.
   * @param {import('./contracts').Rules} rules @returns {import('./contracts').FilterDecision} */
  function evaluateRelevance(title, evidence, rules) {
    const text = identifierText(title + "\n" + evidence),
      profile =
        rules.relevance || relevanceProfile(rules.include, rules.options || {}),
      candidates = modelsIn(text),
      groupFor = (term) =>
        (rules.options?.synonyms || []).find((group) =>
          group.some((word) => normalize(word) === normalize(term)),
        ) || [term];
    const solQuery = /^\d+(?:\.\d+)+[\s_-]*sol$/.test(
      identifierText(rules.include.join(" ")),
    );
    const hits = rules.include.filter(
      (term) =>
        // In a split abbreviation, "Sol" alone cannot establish relevance.
        !(solQuery && normalize(term) === "sol") &&
        groupFor(term).some((word) =>
          flexibleContains(text, word, rules.options?.wordBoundary),
        ),
    );
    const namedMatch = profile.models.some((model) =>
      candidates.some(
        (item) =>
          item.family === model.family &&
          versionMatches(item.version, model.version),
      ),
    );
    // "6.1 Sol" is an abbreviation explicitly requested by the user; numbers alone are not evidence.
    const abbreviated = profile.models.some(
      (model) =>
        model.family === "gpt" &&
        new RegExp(
          String.raw`(?<![\d.])${escaped(model.version)}(?![\d.])[\s_-]*sol(?![a-z])`,
          "u",
        ).test(text),
    );
    if (
      namedMatch ||
      abbreviated ||
      (rules.include.length && hits.length === rules.include.length)
    )
      return {
        keep: true,
        relevance: "relevant",
        reason: "命中搜索词、型号写法或已有简介 / 标签中的关联线索",
      };
    if (!rules.include.length) return { keep: true, reason: "未命中排除词" };
    const contradictory = profile.models.find((model) => {
      const sameFamily = candidates.filter(
        (item) => item.family === model.family,
      );
      return (
        sameFamily.length &&
        sameFamily.every(
          (item) => !compatibleVersion(item.version, model.version),
        )
      );
    });
    if (
      contradictory &&
      !/对比|比较|盘点|回顾|下一代|新模型|\bvs\b|versus/u.test(text)
    )
      return {
        keep: false,
        relevance: "unrelated",
        reason: `已识别其他 ${contradictory.family.toUpperCase()} 版本，未发现目标版本线索：${contradictory.version}`,
      };
    if (hits.length)
      return {
        keep: true,
        relevance: "uncertain",
        reason: "命中部分关联词，信息不足，先保留",
      };
    const hasTargetContext = (model) => {
      const relatedFamilies =
        model.family === "gpt"
          ? ["gpt", "chatgpt", "openai", "open ai"]
          : model.family === "iphone" || model.family === "ipad"
            ? [model.family, "apple", "苹果"]
            : [model.family];
      return relatedFamilies.some((family) =>
        new RegExp(`(?<![a-z0-9])${escaped(family)}(?![a-z])`, "u").test(text),
      );
    };
    const foreignSubject = profile.models.find((model) => {
      if (!modelTopics[model.family]) return false;
      return (
        !hasTargetContext(model) &&
        candidates.some(
          (item) =>
            item.family !== model.family &&
            modelTopics[item.family] === modelTopics[model.family],
        )
      );
    });
    if (foreignSubject)
      return {
        keep: false,
        relevance: "unrelated",
        reason: `已识别其他型号主题，未发现 ${foreignSubject.family.toUpperCase()} ${foreignSubject.version} 关联线索`,
      };
    if (profile.models.some(hasTargetContext))
      return {
        keep: true,
        relevance: "uncertain",
        reason: "存在目标型号家族 / 品牌线索，具体版本关联待确认",
      };
    const candidateTopics = topicIds(text);
    if (
      profile.topics.length &&
      candidateTopics.length &&
      !profile.topics.some((topic) => candidateTopics.includes(topic))
    )
      return {
        keep: false,
        relevance: "unrelated",
        reason: "已有标题 / 简介 / 标签显示不同主题，未发现搜索关联线索",
      };
    return {
      keep: false,
      relevance: "unrelated",
      reason: "已有标题 / 简介 / 标签未发现搜索词、别名或目标型号 / 品牌线索",
    };
  }
  // Whitespace separates terms; ASCII double quotes keep a phrase together.
  function parseQuery(input) {
    const include = [],
      exclude = [];
    const source = String(input ?? "");
    let i = 0;
    while (i < source.length) {
      while (/\s/u.test(source[i] ?? "") && i < source.length) i++;
      if (i === source.length) break;
      const negative = source[i] === "-";
      if (negative) i++;
      let value = "";
      if (source[i] === '"') {
        i++;
        while (i < source.length && source[i] !== '"') value += source[i++];
        if (i === source.length)
          return {
            include: [],
            exclude: [],
            error: "双引号未闭合；已暂停筛选，请补上右引号。",
          };
        i++;
        if (i < source.length && !/\s/u.test(source[i])) {
          return {
            include: [],
            exclude: [],
            error: "完整短语与下一个词之间需要空格；已暂停筛选。",
          };
        }
      } else {
        while (i < source.length && !/\s/u.test(source[i])) {
          if (source[i] === '"')
            return {
              include: [],
              exclude: [],
              error: "双引号应放在词组开头；已暂停筛选。",
            };
          value += source[i++];
        }
      }
      if (!normalize(value))
        return {
          include: [],
          exclude: [],
          error: "关键词不能为空；已暂停筛选。",
        };
      (negative ? exclude : include).push(value.trim());
    }
    return { include: unique(include), exclude: unique(exclude), error: null };
  }
  /** @param {import('./contracts').SearchOptions} options @returns {import('./contracts').Rules} */
  function compileRules(query, exclusions = "", mode = "all", options = {}) {
    const parsed = parseQuery(query);
    const extra = parseQuery(exclusions);
    const phrases = new Set(
      [...String(query).matchAll(/"([^"]+)"/g)].map((match) =>
        normalize(match[1]),
      ),
    );
    return {
      include:
        options.segmentChinese && typeof Intl.Segmenter === "function"
          ? unique(
              parsed.include.flatMap((term) =>
                /[\u4e00-\u9fff]/u.test(term) &&
                !term.includes(" ") &&
                !phrases.has(normalize(term))
                  ? [
                      ...new Intl.Segmenter("zh", {
                        granularity: "word",
                      }).segment(term),
                    ]
                      .filter((s) => s.isWordLike)
                      .map((s) => s.segment)
                  : [term],
              ),
            )
          : parsed.include,
      exclude: unique([...parsed.exclude, ...extra.include, ...extra.exclude]),
      mode: mode === "related" ? "related" : mode === "any" ? "any" : "all",
      error: parsed.error || extra.error,
      options,
      relevance:
        mode === "related"
          ? relevanceProfile(parsed.include, options)
          : undefined,
    };
  }
  /** @param {import('./contracts').Rules} rules @returns {import('./contracts').FilterDecision} */
  function evaluate(title, rules, evidence = "", tagEvidence = []) {
    const text = normalize(title);
    if (rules.error) return { keep: true, reason: "规则有误，保留结果" };
    if (!text)
      return { keep: true, unknown: true, reason: "无法读取标题，保留结果" };
    const contains = (term, source = text) => {
      const group = (rules.options?.synonyms || []).find((words) =>
        words.some((word) => normalize(word) === normalize(term)),
      ) || [term];
      return group.some((word) => {
        const needle = normalize(word);
        if (rules.mode === "related")
          return flexibleContains(
            identifierText(source),
            word,
            rules.options?.wordBoundary,
          );
        if (!rules.options?.wordBoundary || !/[a-z0-9]/i.test(needle))
          return source.includes(needle);
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "u").test(
          source,
        );
      });
    };
    const excluded = rules.exclude.filter((term) => contains(term));
    if (excluded.length)
      return { keep: false, reason: `命中排除词：${excluded.join("、")}` };
    if (rules.mode === "related") {
      const result = evaluateRelevance(title, evidence, rules);
      if (!result.keep) result.queryMismatch = true;
      return result;
    }
    const missing = rules.include.filter(
      (term) =>
        !contains(term) &&
        !tagEvidence.some((tag) => contains(term, normalize(tag))),
    );
    const rejected =
      rules.include.length > 0 &&
      (rules.mode === "any"
        ? missing.length === rules.include.length
        : missing.length > 0);
    if (rejected)
      return {
        keep: false,
        queryMismatch: true,
        reason: `${rules.mode === "any" ? "未包含任一关键词" : "标题缺少关键词"}：${missing.join("、")}`,
      };
    return {
      keep: true,
      reason: rules.include.length ? "符合标题匹配条件" : "未命中排除词",
    };
  }
  /** @param {import('./contracts').VideoCard} card @param {import('./contracts').Rules} rules @param {import('./contracts').SearchOptions} options */
  function evaluateVideo(card, rules, options = {}) {
    const uploader = [String(card.uid || ""), normalize(card.author || "")];
    if (
      (options.allowedUploaders || []).some((x) =>
        uploader.includes(normalize(x)),
      )
    )
      return { keep: true, reason: "UP 主白名单" };
    if (
      (options.blockedUploaders || []).some((x) =>
        uploader.includes(normalize(x)),
      )
    )
      return { keep: false, reason: "命中 UP 主屏蔽规则" };
    if (options.hidePromotions && card.promoted)
      return { keep: false, reason: "已关闭推广卡片" };
    const titleRules = compileRules("", options.blockedTitles || "");
    const blocked = evaluate(card.title, titleRules);
    if (!blocked.keep) return blocked;
    if (
      Number.isFinite(card.duration) &&
      ((options.minDuration > 0 && card.duration < options.minDuration) ||
        (options.maxDuration > 0 && card.duration > options.maxDuration))
    )
      return { keep: false, reason: "不符合时长条件" };
    if (
      Number.isFinite(card.views) &&
      options.minViews > 0 &&
      card.views < options.minViews
    )
      return { keep: false, reason: "低于播放量条件" };
    if (
      Number.isFinite(card.pubdate) &&
      options.afterDate &&
      card.pubdate < new Date(options.afterDate + "T00:00:00").getTime() / 1000
    )
      return { keep: false, reason: "早于指定日期" };
    if (
      Number.isInteger(card.tid) &&
      (options.allowedTids || []).length &&
      !options.allowedTids.includes(card.tid)
    )
      return { keep: false, reason: "不属于选定分区" };
    const evidence = [
      typeof card.description === "string"
        ? card.description.slice(0, 2000)
        : "",
      ...(Array.isArray(card.tags)
        ? card.tags
            .filter((tag) => typeof tag === "string")
            .slice(0, 50)
            .map((tag) => tag.slice(0, 100))
        : []),
    ].join("\n");
    const tags =
      options.useVideoTags && Array.isArray(card.tags)
        ? card.tags
            .filter((tag) => typeof tag === "string")
            .slice(0, 50)
            .map((tag) => tag.slice(0, 100))
        : [];
    const result = evaluate(card.title, rules, evidence, tags);
    if (
      options.useVideoTags &&
      rules.mode !== "related" &&
      result.queryMismatch
    )
      result.reason = result.reason.replace(
        "标题缺少关键词",
        "标题 / 标签缺少关键词",
      );
    if (tags.length && result.keep && evaluate(card.title, rules).queryMismatch)
      result.reason = "视频标签命中搜索关键词，已保留";
    return result;
  }
  const api = Object.freeze({
    normalize,
    parseQuery,
    compileRules,
    evaluate,
    evaluateVideo,
  });
  root.BiliSearchLens = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
