(function (root) {
  "use strict";
  const KEY = "lensSettingsV2";
  const defaults = {
    version: 2,
    searchExperienceVersion: 1,
    modules: { search: false, tools: true, player: false, browsing: false },
    search: {
      mode: "related",
      relevanceVersion: 1,
      useVideoTags: true,
      fillPages: false,
      exclusions: "",
      expanded: true,
      wordBoundary: false,
      segmentChinese: false,
      synonyms: [],
      blockedUploaders: [],
      allowedUploaders: [],
      allowedTids: [],
      blockedTitles: "",
      hidePromotions: false,
      minDuration: 0,
      maxDuration: 0,
      minViews: 0,
      afterDate: "",
      sort: "original",
    },
    danmaku: {
      exclusions: "",
      whitelist: "",
      regex: [],
      blockedModes: [],
      blockedColors: [],
      blockedSenders: [],
      maxLength: 0,
      duplicateWindow: 8,
      duplicateLimit: 3,
      fontSize: 25,
      opacity: 0.75,
      area: 0.5,
      speed: 1,
      density: 40,
    },
    player: { rate: 1, rememberRate: true, seekSeconds: 5, shortcuts: true },
    ui: { theme: "auto", position: "right" },
    hiddenSections: [],
    profiles: [],
    bookmarks: [],
    savedSearches: [],
    syncEnabled: false,
    downloads: {
      concurrent: 2,
      filename: "{title}/P{page}-{part}-{kind}",
      conflictAction: "uniquify",
    },
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  function mergeSafe(base, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return copy(base);
    const output = copy(base);
    for (const name of Object.keys(base)) {
      const value = input[name],
        original = base[name];
      if (Array.isArray(original) && Array.isArray(value))
        output[name] = copy(value).slice(0, 500);
      else if (original && typeof original === "object")
        output[name] = mergeSafe(original, value);
      else if (
        typeof value === typeof original &&
        (typeof value !== "number" || Number.isFinite(value))
      )
        output[name] =
          typeof value === "string" ? value.slice(0, 10000) : value;
    }
    return output;
  }
  function validate(input) {
    if (!input || input.version !== 2)
      throw new Error("仅支持版本 2 的配置文件");
    if (new TextEncoder().encode(JSON.stringify(input)).length > 200000)
      throw new Error("配置超过 200 KB");
    const result = mergeSafe(defaults, input);
    result.searchExperienceVersion = 1;
    for (const name of ["blockedUploaders", "allowedUploaders"])
      result.search[name] = result.search[name]
        .filter((x) => typeof x === "string")
        .map((x) => x.slice(0, 100));
    result.search.synonyms = result.search.synonyms.filter(
      (x) =>
        Array.isArray(x) &&
        x.length <= 20 &&
        x.every((y) => typeof y === "string" && y.length <= 100),
    );
    result.search.allowedTids = result.search.allowedTids.filter(
      (x) => Number.isInteger(x) && x > 0,
    );
    for (const name of ["regex", "blockedSenders"])
      result.danmaku[name] = result.danmaku[name]
        .filter((x) => typeof x === "string" && x.length <= 200)
        .slice(0, 100);
    result.danmaku.blockedModes = result.danmaku.blockedModes.filter(
      (x) => Number.isInteger(x) && x >= 1 && x <= 9,
    );
    result.danmaku.blockedColors = result.danmaku.blockedColors.filter(
      (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffff,
    );
    for (const field of ["minDuration", "maxDuration", "minViews"])
      result.search[field] = Math.max(0, result.search[field]);
    if (
      result.search.maxDuration &&
      result.search.maxDuration < result.search.minDuration
    )
      throw new Error("最大时长不能小于最小时长");
    if (
      result.search.afterDate &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(result.search.afterDate) ||
        !Number.isFinite(Date.parse(result.search.afterDate)) ||
        new Date(result.search.afterDate).toISOString().slice(0, 10) !==
          result.search.afterDate)
    )
      throw new Error("日期格式应为有效的 YYYY-MM-DD");
    result.search.sort = ["original", "match", "views", "date"].includes(
      result.search.sort,
    )
      ? result.search.sort
      : "original";
    result.search.mode = ["related", "all", "any"].includes(result.search.mode)
      ? result.search.mode
      : "related";
    result.search.relevanceVersion = 1;
    result.downloads.concurrent = Math.max(
      1,
      Math.min(3, Math.floor(result.downloads.concurrent)),
    );
    result.downloads.conflictAction = [
      "uniquify",
      "overwrite",
      "prompt",
    ].includes(result.downloads.conflictAction)
      ? result.downloads.conflictAction
      : "uniquify";
    result.player.rate = Math.max(0.25, Math.min(4, result.player.rate));
    result.player.seekSeconds = Math.max(
      1,
      Math.min(120, result.player.seekSeconds),
    );
    result.danmaku.opacity = Math.max(0.1, Math.min(1, result.danmaku.opacity));
    result.danmaku.area = Math.max(0.1, Math.min(1, result.danmaku.area));
    result.danmaku.fontSize = Math.max(
      12,
      Math.min(72, result.danmaku.fontSize),
    );
    result.danmaku.speed = Math.max(0.25, Math.min(4, result.danmaku.speed));
    result.danmaku.density = Math.max(
      1,
      Math.min(100, Math.floor(result.danmaku.density)),
    );
    result.danmaku.duplicateWindow = Math.max(
      0,
      Math.min(120, result.danmaku.duplicateWindow),
    );
    result.danmaku.duplicateLimit = Math.max(
      0,
      Math.min(100, Math.floor(result.danmaku.duplicateLimit)),
    );
    result.danmaku.maxLength = Math.max(
      0,
      Math.min(1000, result.danmaku.maxLength),
    );
    result.ui.theme = ["auto", "light", "dark"].includes(result.ui.theme)
      ? result.ui.theme
      : "auto";
    result.ui.position = result.ui.position === "left" ? "left" : "right";
    result.hiddenSections = result.hiddenSections.filter((x) =>
      ["related", "hotSearch", "comments"].includes(x),
    );
    result.profiles = result.profiles
      .filter(
        (x) =>
          x &&
          typeof x === "object" &&
          typeof x.scope === "string" &&
          /^(BV\w+|av\d+|up:\d+)$/.test(x.scope) &&
          x.rules &&
          typeof x.rules === "object",
      )
      .map((x) => ({
        scope: x.scope,
        rules: validate({ ...defaults, profiles: [], danmaku: x.rules })
          .danmaku,
      }));
    result.bookmarks = result.bookmarks
      .filter(
        (x) =>
          x &&
          /^BV\w+$/.test(x.bvid) &&
          Number.isFinite(x.time) &&
          x.time >= 0 &&
          typeof x.note === "string",
      )
      .map((x) => ({
        bvid: x.bvid,
        time: x.time,
        note: x.note.slice(0, 1000),
        ...(Number.isSafeInteger(x.cid) && x.cid > 0 ? { cid: x.cid } : {}),
        page: Number.isInteger(x.page) && x.page > 0 ? x.page : 1,
      }));
    result.savedSearches = result.savedSearches
      .filter((x) => typeof x === "string")
      .map((x) => x.slice(0, 2000));
    return result;
  }
  // All document contexts share the worker's transaction queue. A module-local
  // lock alone cannot protect a migration from another tab's explicit save.
  const transactions = new WeakMap();
  function transaction(storage, action) {
    const prior = transactions.get(storage) || Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    transactions.set(storage, next);
    return next;
  }
  function inDocument(storage) {
    return (
      storage === root.chrome?.storage?.local &&
      !!root.chrome?.runtime?.id &&
      typeof root.document !== "undefined"
    );
  }
  async function workerSettings(message) {
    let timer;
    try {
      const response = await Promise.race([
        root.chrome.runtime.sendMessage(message),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("读取或保存设置超时，请重试")),
            5000,
          );
        }),
      ]);
      if (!response?.ok) throw new Error(response?.error || "设置操作失败");
      return validate(response.result);
    } finally {
      clearTimeout(timer);
    }
  }
  async function read(storage) {
    if (!storage) return copy(defaults);
    const saved = await storage.get([KEY, "biliSearchLensSettings"]);
    if (saved[KEY]) {
      const value = validate(saved[KEY]);
      for (const field of [
        "exclusions",
        "expanded",
        "useVideoTags",
        "fillPages",
      ])
        if (
          saved[KEY].search?.[field] === undefined &&
          typeof saved.biliSearchLensSettings?.[field] ===
            typeof defaults.search[field]
        )
          value.search[field] = saved.biliSearchLensSettings[field];
      // One-time migration from the previous strict default, following the user's correction.
      let migrated = false;
      if (saved[KEY].search?.relevanceVersion !== 1) {
        value.search.mode =
          saved[KEY].search?.mode === "any" ? "any" : "related";
        migrated = true;
      }
      // The user chose independent search as the main experience. Disable the
      // legacy DOM filter/refill once on upgrade, keeping every other rule.
      if (saved[KEY].searchExperienceVersion !== 1) {
        value.modules.search = false;
        value.search.fillPages = false;
        migrated = true;
      }
      if (migrated && storage.set) await storage.set({ [KEY]: value });
      return value;
    }
    const migrated = copy(defaults);
    for (const field of ["exclusions", "expanded", "useVideoTags", "fillPages"])
      if (
        typeof saved.biliSearchLensSettings?.[field] ===
        typeof defaults.search[field]
      )
        migrated.search[field] = saved.biliSearchLensSettings[field];
    if (
      (saved.biliSearchLensSettings?.relevanceVersion === 1 ||
        saved.biliSearchLensSettings?.mode === "any") &&
      ["related", "all", "any"].includes(saved.biliSearchLensSettings.mode)
    )
      migrated.search.mode = saved.biliSearchLensSettings.mode;
    migrated.search.fillPages = false;
    if (saved.biliSearchLensSettings && storage.set)
      await storage.set({ [KEY]: migrated });
    return migrated;
  }
  async function load(storage = root.chrome?.storage?.local) {
    if (!storage) return copy(defaults);
    if (inDocument(storage)) return workerSettings({ op: "settingsLoad" });
    return transaction(storage, () => read(storage));
  }
  async function save(settings, storage = root.chrome?.storage?.local) {
    const value = validate(settings);
    if (inDocument(storage))
      return workerSettings({ op: "settingsSave", settings: value });
    if (storage)
      await transaction(storage, () => storage.set({ [KEY]: value }));
    return value;
  }
  function forVideo(settings, bvid, uid) {
    const up = settings.profiles.find((x) => x.scope === `up:${uid}`);
    const video = settings.profiles.find((x) => x.scope === bvid);
    return validate({
      ...settings,
      danmaku: {
        ...settings.danmaku,
        ...(up?.rules || {}),
        ...(video?.rules || {}),
      },
    }).danmaku;
  }
  const api = { KEY, defaults, copy, validate, load, save, forVideo };
  root.LensSettings = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
