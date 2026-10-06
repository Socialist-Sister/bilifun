(async function () {
  "use strict";
  if (document.getElementById("bili-search-lens")) return;
  const Core = globalThis.BiliSearchLens;
  const Adapter = globalThis.BiliSearchLensAdapter;
  const storage = globalThis.chrome?.storage?.local;
  const key = "biliSearchLensSettings";
  let preferences = {
    enabled: false,
    mode: "related",
    relevanceVersion: 1,
    useVideoTags: true,
    fillPages: true,
    exclusions: "",
    expanded: true,
  };
  let storageMessage = "";
  try {
    const saved = (await storage?.get(key))?.[key];
    if (saved && typeof saved === "object") {
      preferences = {
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
        mode:
          saved.relevanceVersion === 1 &&
          ["related", "all", "any"].includes(saved.mode)
            ? saved.mode
            : "related",
        relevanceVersion: 1,
        useVideoTags: saved.useVideoTags !== false,
        fillPages: saved.fillPages !== false,
        exclusions:
          typeof saved.exclusions === "string"
            ? saved.exclusions.slice(0, 2000)
            : "",
        expanded: typeof saved.expanded === "boolean" ? saved.expanded : true,
      };
    }
  } catch {
    storageMessage = "无法读取设置，本次使用默认条件。";
  }
  let systemSettings;
  try {
    systemSettings = await globalThis.LensSettings?.load(storage);
  } catch {
    storageMessage = "配置无法读取；已使用默认条件。";
  }
  if (systemSettings) {
    preferences.enabled = systemSettings.modules.search;
    for (const field of [
      "mode",
      "exclusions",
      "expanded",
      "useVideoTags",
      "fillPages",
    ])
      preferences[field] = systemSettings.search[field];
  }
  // Disabled experiments must not mount a panel, scan results or request data.
  // Enabling from settings takes effect after refreshing the search page.
  if (!systemSettings?.modules.search) return;
  const originalOrders = new Map();
  const hiddenSlots = new Set();
  const refill = new globalThis.LensRefill.Controller(
    (message, options) => globalThis.LensRpc.request(message, options),
    schedule,
  );
  const pagination = globalThis.LensPagination
    ? new globalThis.LensPagination.Client(
        (message, options) => globalThis.LensRpc.request(message, options),
        schedule,
      )
    : null;
  let currentKeyword = Adapter.keywordFromUrl(location.href);
  let showHidden = false;
  let marked = new Set();
  let scheduled;
  let saveTimer;
  let hiddenResults = [];
  let inactive = false;
  const allowedVideos = new Set();
  const tagStates = new Map();
  let tagPermission = false,
    tagPermissionKnown = false,
    tagActive = 0,
    tagBudget = 0,
    tagRun = 0,
    tagSequence = 0;
  let tagRoute = location.href;
  const tagTokens = new Set();
  async function refreshTagPermission() {
    if (!preferences.enabled || inactive) return;
    try {
      const allowed =
        (await globalThis.LensRpc?.request(
          { op: "tagStatus" },
          { timeout: 5000 },
        )) === true;
      const changed = allowed !== tagPermission || !tagPermissionKnown;
      tagPermission = allowed;
      tagPermissionKnown = true;
      if (changed && !inactive) schedule();
    } catch {
      const changed = tagPermission || !tagPermissionKnown;
      tagPermission = false;
      tagPermissionKnown = true;
      if (changed && !inactive) schedule();
    }
  }
  function stopTagLookups() {
    tagRun++;
    for (const token of tagTokens)
      globalThis.chrome?.runtime
        ?.sendMessage({ op: "cancelRequest", token })
        .catch(() => {});
    tagTokens.clear();
    for (const [id, state] of tagStates)
      if (state.status !== "done") tagStates.delete(id);
  }
  function lookupTags(videoId) {
    if (
      !tagPermission ||
      tagStates.has(videoId) ||
      tagActive >= 2 ||
      tagBudget >= 30
    )
      return;
    const run = tagRun,
      token = `tags-${tagRun}-${++tagSequence}`;
    tagStates.set(videoId, { status: "pending" });
    tagTokens.add(token);
    tagActive++;
    tagBudget++;
    globalThis.LensRpc.request({ op: "videoTags", id: videoId, token })
      .then((tags) => {
        if (run !== tagRun || inactive) return;
        if (
          !Array.isArray(tags) ||
          tags.length > 50 ||
          tags.some((tag) => typeof tag !== "string" || tag.length > 100)
        )
          throw new Error("标签查询失败");
        tagStates.set(videoId, { status: "done", tags });
      })
      .catch(() => {
        if (run === tagRun && !inactive)
          tagStates.set(videoId, { status: "failed" });
      })
      .finally(() => {
        tagTokens.delete(token);
        tagActive--;
        if (!inactive) schedule();
      });
  }
  const host = document.createElement("aside");
  host.id = "bili-search-lens";
  host.setAttribute("aria-label", "B 站搜索筛选");
  host.style.cssText =
    "position:fixed;bottom:18px;right:18px;z-index:2147483646;width:min(360px,calc(100vw - 24px));color-scheme:light;";
  const shadow = host.attachShadow({ mode: "open" });
  // Static markup only. Page titles and user input are inserted via textContent.
  shadow.innerHTML = `
    <style>
      :host { font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif; color:#253849; }
      * { box-sizing:border-box; } .panel { background:#fff; border:1px solid #cddce5; border-radius:14px; box-shadow:0 6px 28px #25384926; overflow:hidden; }
      button,input,select { font:inherit; } button { cursor:pointer; } button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible { outline:3px solid #1484ad; outline-offset:2px; }
      header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#eef7fc; gap:10px; }
      h2 { font-size:15px; margin:0; font-weight:700; } .status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#117e99; margin-right:7px; }
      header button { border:0; background:transparent; color:#366172; padding:5px 2px; font-size:12px; }
      .body { padding:14px 16px 16px; max-height:65vh; overflow:auto; } [hidden] { display:none !important; }
      .intro,.hint,.footnote { font-size:12px; color:#5e7280; margin:0 0 12px; } .hint { margin:5px 0 0; }
      .field { display:block; margin-bottom:12px; } .field>span { display:block; margin-bottom:5px; font-weight:600; font-size:12px; }
      input[type=text],select { width:100%; padding:8px 10px; color:#253849; border:1px solid #bfcfd9; border-radius:7px; background:#fff; }
      .toggle { display:flex; align-items:center; gap:8px; font-weight:600; margin-bottom:12px; } input[type=checkbox] { accent-color:#117e99; width:16px; height:16px; }
      .actions { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; } .actions button { padding:7px 10px; border:1px solid #bfcfd9; border-radius:7px; background:#fff; color:#366172; font-size:12px; }
      .stats { border-left:3px solid #117e99; padding:7px 10px; background:#f0f7fa; font-size:12px; margin:12px 0; font-variant-numeric:tabular-nums; }
      .notice { color:#855116; font-size:12px; margin:8px 0; } details { border-top:1px solid #e0e9ef; padding-top:10px; font-size:12px; } summary { cursor:pointer; font-weight:600; }
      ol { margin:8px 0 0; padding-left:20px; max-height:180px; overflow:auto; } li { margin:0 0 9px; } a { color:#117e99; overflow-wrap:anywhere; } .reason { display:block; color:#6c7780; }
      .footnote { margin:12px 0 0; } @media(max-width:480px) { .body { max-height:55vh; } }
      :host([data-theme=dark]){color:#e2eff5} :host([data-theme=dark]) .panel,:host([data-theme=dark]) input,:host([data-theme=dark]) select,:host([data-theme=dark]) .actions button{background:#20323f;color:#e2eff5;border-color:#415765} :host([data-theme=dark]) header,:host([data-theme=dark]) .stats{background:#293f4c} :host([data-theme=dark]) .reason,:host([data-theme=dark]) .intro,:host([data-theme=dark]) .hint,:host([data-theme=dark]) .footnote{color:#a5bdc9}
    </style>
    <section class="panel">
      <header><h2><span class="status-dot" aria-hidden="true"></span>BiliFun</h2><button id="collapse" type="button" aria-controls="body">收起</button></header>
      <div id="body" class="body">
        <p class="intro">结合标题、简介和标签，隐藏缺少关联线索的结果。</p>
        <label class="toggle"><input id="enabled" type="checkbox">启用搜索筛选</label>
        <label class="field"><span id="query-label">搜索主题</span><input id="query" type="text" maxlength="2000" placeholder="机械键盘 静音" autocomplete="off"><p class="hint" id="mode-hint">识别型号的不同写法；无关联线索时隐藏。-词 表示排除。</p></label>
        <label class="field"><span>匹配方式</span><select id="mode"><option value="related">谨慎去除无关结果（默认）</option><option value="all">标题包含全部关键词（严格）</option><option value="any">标题包含任一关键词</option></select></label>
        <label class="toggle"><input id="video-tags" type="checkbox">同时核对视频页标签</label>
        <p class="hint" id="tag-status"></p>
        <div class="actions"><button id="tag-settings" type="button">授权 / 设置标签查询</button></div>
        <label class="toggle"><input id="fill-pages" type="checkbox">自动从后续页补齐视频</label>
        <p class="hint" id="fill-status" role="status"></p>
        <div class="actions"><button id="fill-stop" type="button">停止补位</button></div>
        <label class="field"><span>排除词（会在下次搜索沿用）</span><input id="exclusions" type="text" maxlength="2000" placeholder="带货 抽奖" autocomplete="off"></label>
        <div class="stats" id="stats" role="status" aria-live="polite"></div>
        <p class="hint" id="active-rule"></p>
        <p class="notice" id="notice" role="status" hidden></p>
        <div class="actions"><button id="show" type="button" aria-pressed="false">查看被隐藏结果</button><button id="reset" type="button">恢复当前搜索词</button><button id="settings" type="button">完整设置与工具</button></div>
        <details><summary id="reason-summary">隐藏原因</summary><ol id="reasons"></ol></details>
        <p class="footnote" id="scope">仅处理当前已加载的视频卡片。标题包含关键词不代表内容一定相关。</p>
      </div>
    </section>`;
  const $ = (id) => shadow.getElementById(id);
  $("query").value = currentKeyword.slice(0, 2000);
  $("mode").value = preferences.mode;
  $("exclusions").value = preferences.exclusions;
  $("enabled").checked = preferences.enabled;
  $("video-tags").checked = preferences.useVideoTags;
  $("fill-pages").checked = preferences.fillPages;
  function updateExpanded() {
    $("body").hidden = !preferences.expanded;
    $("collapse").textContent = preferences.expanded ? "收起" : "展开筛选";
    $("collapse").setAttribute("aria-expanded", String(preferences.expanded));
  }
  updateExpanded();
  document.body.append(host);
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!storage) return;
      try {
        if (globalThis.LensSettings) {
          const latest = await globalThis.LensSettings.load(storage);
          latest.modules.search = preferences.enabled;
          for (const field of [
            "mode",
            "exclusions",
            "expanded",
            "useVideoTags",
            "fillPages",
          ])
            latest.search[field] = preferences[field];
          systemSettings = await globalThis.LensSettings.save(latest, storage);
        }
        await storage.set({ [key]: { ...preferences } });
      } catch {
        storageMessage = "设置未能保存；当前页筛选仍然有效。";
        schedule();
      }
    }, 300);
  }
  function restore(element) {
    element.removeAttribute("data-bili-search-lens-hidden");
  }
  function renderReasons(results) {
    // Do not rebuild an open explanation list on unrelated page mutations.
    const signature = JSON.stringify(
      results.map((item) => [item.title, item.url, item.reason]),
    );
    if (signature === hiddenResults.signature) return;
    hiddenResults = results;
    hiddenResults.signature = signature;
    const fragment = document.createDocumentFragment();
    for (const result of results) {
      const item = document.createElement("li");
      const link = document.createElement(result.url ? "a" : "span");
      link.textContent = result.title;
      if (result.url) {
        link.href = result.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      const reason = document.createElement("span");
      reason.className = "reason";
      reason.textContent = result.reason;
      item.append(link, reason);
      if (result.url && !result.duplicate) {
        const allow = document.createElement("button");
        allow.type = "button";
        allow.textContent = "本次放行";
        allow.addEventListener("click", () => {
          allowedVideos.add(result.url);
          process();
        });
        item.append(allow);
      }
      fragment.append(item);
    }
    $("reasons").replaceChildren(fragment);
  }
  function process() {
    clearTimeout(scheduled);
    if (inactive) return;
    if (!preferences.enabled) {
      // Restore only elements owned by the experiment, without scanning cards.
      for (const element of marked) restore(element);
      marked.clear();
      for (const slot of hiddenSlots)
        slot.removeAttribute("data-lens-search-slot-hidden");
      hiddenSlots.clear();
      for (const [element, order] of originalOrders)
        element.style.order = order;
      originalOrders.clear();
      refill.cancel();
      refill.remove();
      $("stats").textContent = "筛选已关闭";
      $("fill-status").textContent = "跨页补位已关闭";
      $("fill-stop").disabled = true;
      $("show").disabled = true;
      $("notice").hidden = true;
      renderReasons([]);
      return;
    }
    for (const slot of hiddenSlots)
      slot.removeAttribute("data-lens-search-slot-hidden");
    hiddenSlots.clear();
    if (tagRoute !== location.href) {
      stopTagLookups();
      tagBudget = 0;
      tagRoute = location.href;
      // Keep only a small amount of public metadata in this document.
      while (tagStates.size > 60)
        tagStates.delete(tagStates.keys().next().value);
    }
    const cautious = preferences.mode === "related";
    $("query-label").textContent = cautious
      ? "搜索主题"
      : preferences.useVideoTags
        ? "标题 / 标签匹配词"
        : "标题必须包含";
    $("mode").options[1].textContent = preferences.useVideoTags
      ? "标题 / 标签包含全部关键词（严格）"
      : "标题包含全部关键词（严格）";
    $("mode").options[2].textContent = preferences.useVideoTags
      ? "标题 / 标签包含任一关键词"
      : "标题包含任一关键词";
    $("mode-hint").textContent = cautious
      ? "识别型号空格、连字符写法，参考简介 / 标签；缺少关联线索时隐藏。-词 表示排除。"
      : "空格分词，双引号保留完整短语；-词 表示排除。";
    const keyword = Adapter.keywordFromUrl(location.href);
    if (keyword !== currentKeyword) {
      currentKeyword = keyword;
      allowedVideos.clear();
      $("query").value = keyword.slice(0, 2000);
      showHidden = false;
    }
    // Clear owned markers and reapply synchronously before the browser paints.
    // This lets the adapter distinguish our hiding from the website's CSS.
    for (const element of document.querySelectorAll(
      '[data-bili-search-lens-hidden="true"]',
    ))
      restore(element);
    const cards = Adapter.collectCards(document);
    const nativeLayout = globalThis.LensRefill.measureSlots(cards);
    const rules = Core.compileRules(
      $("query").value,
      preferences.exclusions,
      preferences.mode,
      systemSettings?.search || {},
    );
    const filtering = preferences.enabled && !rules.error;
    if (pagination && preferences.fillPages && filtering && !showHidden) {
      const groups = new Map();
      for (const card of cards) {
        const parent = Adapter.layoutElement(card.element).parentElement;
        if (parent) groups.set(parent, (groups.get(parent) || 0) + 1);
      }
      const container = [...groups].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (container) {
        const pageSize = [...container.children].filter(
          (node) =>
            !node.hasAttribute("data-lens-refill-owned") &&
            (node.matches(Adapter.CARD_SELECTOR) ||
              node.querySelector(Adapter.CARD_SELECTOR)),
        ).length;
        const options = {
          ...systemSettings?.search,
          expanded: undefined,
          fillPages: undefined,
          mode: undefined,
          exclusions: undefined,
          useVideoTags: undefined,
        };
        pagination.prepare(
          location.href,
          pageSize,
          { ...rules, options },
          preferences.useVideoTags,
        );
      }
    }
    $("active-rule").textContent =
      `当前规则：${cautious ? "谨慎去除无关结果" : preferences.mode === "all" ? "全部关键词（严格）" : "任一关键词"} · ${$("query").value || "仅排除"}`;
    const nextMarked = new Set();
    const rejected = [];
    const entries = [];
    const currentIds = new Set();
    let unreadable = 0,
      uncertain = 0,
      tagWaiting = 0,
      tagFailed = 0,
      tagLimited = 0,
      tagRescued = 0;
    for (const card of cards) {
      const duplicate =
        filtering &&
        preferences.fillPages &&
        !showHidden &&
        pagination?.blocked(card.videoId);
      const state = tagStates.get(card.videoId);
      const taggedCard =
        state?.status === "done" && preferences.useVideoTags
          ? { ...card, tags: [...state.tags, ...card.tags] }
          : card;
      const base = Core.evaluateVideo(
        card,
        rules,
        systemSettings?.search || {},
      );
      let result = allowedVideos.has(card.url)
        ? { keep: true, reason: "本次临时放行" }
        : Core.evaluateVideo(taggedCard, rules, systemSettings?.search || {});
      const needsTags =
        !duplicate &&
        !pagination?.pending &&
        rules.include.length &&
        (result.queryMismatch || result.relevance === "uncertain");
      if (duplicate)
        result = {
          keep: false,
          duplicate: true,
          reason: `已在第 ${pagination.owner(card.videoId)} 页展示，后续结果将补位`,
        };
      if (
        filtering &&
        preferences.useVideoTags &&
        card.videoId &&
        needsTags &&
        state?.status !== "done" &&
        !allowedVideos.has(card.url)
      ) {
        lookupTags(card.videoId);
        const nextState = tagStates.get(card.videoId);
        if (nextState?.status === "failed") tagFailed++;
        else if (
          tagPermission &&
          (nextState?.status === "pending" || tagBudget < 30)
        ) {
          tagWaiting++;
          result = {
            keep: true,
            relevance: "uncertain",
            reason: "正在排队 / 查询视频标签，完成后重新判断",
          };
        } else if (tagPermission && tagBudget >= 30) tagLimited++;
      }
      if (
        state?.status === "done" &&
        preferences.useVideoTags &&
        result.keep &&
        (base.queryMismatch || base.relevance === "uncertain") &&
        result.relevance !== "uncertain" &&
        !allowedVideos.has(card.url)
      )
        tagRescued++;
      if (result.unknown) unreadable++;
      if (result.relevance === "uncertain") uncertain++;
      if (
        filtering &&
        preferences.fillPages &&
        !showHidden &&
        result.keep &&
        card.videoId
      ) {
        if (currentIds.has(card.videoId))
          result = {
            keep: false,
            duplicate: true,
            reason: "当前页已显示同一视频",
          };
        else currentIds.add(card.videoId);
      }
      entries.push({ card, keep: !filtering || result.keep });
      if (filtering && !result.keep) {
        rejected.push({
          title: card.promoted ? `推广卡片：${card.title}` : card.title,
          url: card.url,
          reason: result.reason,
          duplicate: result.duplicate,
        });
        if (!showHidden) {
          // Skip identical writes so our MutationObserver cannot trigger itself.
          if (
            card.element.getAttribute("data-bili-search-lens-hidden") !== "true"
          )
            card.element.setAttribute("data-bili-search-lens-hidden", "true");
          nextMarked.add(card.element);
          const slot = Adapter.layoutElement(card.element);
          if (slot !== card.element) {
            slot.setAttribute("data-lens-search-slot-hidden", "true");
            hiddenSlots.add(slot);
          }
        }
      } else if (card.element.hasAttribute("data-bili-search-lens-hidden"))
        restore(card.element);
    }
    for (const element of marked)
      if (!nextMarked.has(element)) restore(element);
    marked = nextMarked;
    for (const [element, order] of originalOrders)
      if (!element.isConnected) {
        element.style.order = order;
        originalOrders.delete(element);
      }
    refill.update({
      url: location.href,
      nativeLayout,
      entries,
      rules,
      options: systemSettings?.search || {},
      enabled: preferences.fillPages && filtering && !showHidden,
      waiting:
        pagination?.pending ||
        (preferences.useVideoTags && (!tagPermissionKnown || tagWaiting > 0)),
      permission: tagPermission,
      blocked: (id) => pagination?.blocked(id),
      waitReason: pagination?.pending ? "等待跨页去重记录后补位" : "",
    });
    if (
      pagination &&
      filtering &&
      preferences.fillPages &&
      !showHidden &&
      !pagination.pending &&
      !(preferences.useVideoTags && (!tagPermissionKnown || tagWaiting))
    )
      pagination.commit([
        ...entries
          .filter((entry) => entry.keep)
          .map((entry) => entry.card.videoId),
        ...refill.items.flatMap((row) => row.aliases),
      ]);
    $("fill-status").textContent = refill.status;
    if (pagination?.error && preferences.fillPages)
      $("fill-status").textContent +=
        ` · 跨页去重记录失败：${pagination.error}`;
    $("fill-stop").textContent = refill.running
      ? "停止补位"
      : "继续 / 重试补位";
    $("fill-stop").disabled =
      !preferences.fillPages ||
      !filtering ||
      showHidden ||
      (!refill.running &&
        !refill.paused &&
        !refill.error &&
        !pagination?.error);
    if (filtering && systemSettings?.search.sort !== "original") {
      const sort = systemSettings?.search.sort;
      const sorted = [...cards, ...refill.items].sort((a, b) =>
        sort === "views"
          ? (b.views || 0) - (a.views || 0)
          : sort === "date"
            ? (b.pubdate || 0) - (a.pubdate || 0)
            : rules.include.filter((t) =>
                Core.normalize(b.title).includes(Core.normalize(t)),
              ).length -
              rules.include.filter((t) =>
                Core.normalize(a.title).includes(Core.normalize(t)),
              ).length,
      );
      sorted.forEach((card, index) => {
        const slot = Adapter.layoutElement(card.element);
        if (!originalOrders.has(slot))
          originalOrders.set(slot, slot.style.order);
        slot.style.order = String(index);
      });
    } else {
      for (const [element, order] of originalOrders)
        element.style.order = order;
      originalOrders.clear();
    }
    const hidden = showHidden ? 0 : rejected.length;
    $("stats").textContent = !preferences.enabled
      ? `筛选已关闭 · 当前识别 ${cards.length} 个视频`
      : `识别 ${cards.length} 个视频 · 保留 ${cards.length - rejected.length} 个${cautious && uncertain ? `（其中 ${uncertain} 个关联待确认）` : ""} · ${showHidden ? `待隐藏 ${rejected.length} 个（正在展示）` : `隐藏 ${hidden} 个`}`;
    if (filtering && !showHidden && refill.items.length)
      $("stats").textContent += ` · 跨页补入 ${refill.items.length} 个`;
    let notice = rules.error || storageMessage;
    if (!notice && !cards.length)
      notice =
        "尚未识别到视频卡片；请等待结果加载，或切换到视频搜索。若页面已显示视频，可能需要更新页面适配。";
    if (
      !notice &&
      filtering &&
      cards.length &&
      rejected.length === cards.length &&
      !refill.items.length
    )
      notice = "全部已加载视频都被隐藏了。可以查看隐藏结果，或放宽匹配条件。";
    if (!notice && unreadable)
      notice = `${unreadable} 个视频无法读取标题，已保留。`;
    if (!notice && cautious && filtering && uncertain)
      notice = `${uncertain} 个视频有部分关联线索或正在核对标签，具体关联待确认。可查看隐藏原因并临时放行。`;
    $("notice").textContent = notice;
    $("notice").hidden = !notice;
    $("show").textContent = showHidden
      ? "重新隐藏不匹配结果"
      : "查看被隐藏结果";
    $("show").setAttribute("aria-pressed", String(showHidden));
    $("show").disabled = !filtering || !rejected.length;
    $("reason-summary").textContent = `隐藏原因（${rejected.length}）`;
    $("tag-status").textContent = !preferences.useVideoTags
      ? "标签核对已关闭，仅使用页面已有信息。"
      : !tagPermissionKnown
        ? "正在检查标签查询权限；暂按页面已有信息筛选。"
        : !tagPermission
          ? "尚未授权数据接口，无法核对视频页标签；按页面已有信息筛选，可授权后补查。"
          : `标签核对：${tagRescued} 个通过标签保留${tagWaiting ? ` · ${tagWaiting} 个待核对（暂时保留）` : ""}${tagFailed ? ` · ${tagFailed} 个查询失败（按页面信息筛选）` : ""}${tagLimited ? ` · ${tagLimited} 个已达本页 30 个查询上限（按页面信息筛选）` : ""}`;
    renderReasons(rejected);
    $("scope").textContent =
      `当前页 ${cards.length} 个视频，跨页补入 ${refill.items.length} 个；${systemSettings?.search.sort === "original" ? "保持原有顺序" : "按设置中的依据排序"}。补位最多读取后续 3 页，标签仅是关联线索。版本 ${globalThis.chrome?.runtime?.getManifest?.().version || "0.3.11"}`;
    host.style.right = systemSettings?.ui.position === "left" ? "" : "18px";
    host.style.left = systemSettings?.ui.position === "left" ? "18px" : "";
    host.dataset.theme =
      systemSettings?.ui.theme === "auto"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : systemSettings?.ui.theme || "light";
  }
  function schedule() {
    clearTimeout(scheduled);
    if (!preferences.enabled || inactive) return;
    scheduled = setTimeout(process, 100);
  }
  $("query").addEventListener("input", schedule);
  $("exclusions").addEventListener("input", () => {
    preferences.exclusions = $("exclusions").value;
    persist();
    schedule();
  });
  $("mode").addEventListener("change", () => {
    preferences.mode = $("mode").value;
    persist();
    process();
  });
  $("enabled").addEventListener("change", () => {
    preferences.enabled = $("enabled").checked;
    if (!preferences.enabled) stopTagLookups();
    persist();
    process();
    syncMonitoring();
  });
  $("video-tags").addEventListener("change", () => {
    preferences.useVideoTags = $("video-tags").checked;
    if (systemSettings)
      systemSettings.search.useVideoTags = preferences.useVideoTags;
    if (!preferences.useVideoTags) stopTagLookups();
    persist();
    process();
  });
  $("tag-settings").addEventListener("click", () =>
    chrome.runtime?.sendMessage({ op: "openSettings" }),
  );
  $("fill-pages").addEventListener("change", () => {
    preferences.fillPages = $("fill-pages").checked;
    persist();
    process();
  });
  $("fill-stop").addEventListener("click", () => {
    if (refill.running) refill.stop();
    else {
      if (pagination?.error) pagination.reset();
      refill.retry();
    }
    process();
  });
  window.addEventListener("resize", schedule);
  window.addEventListener("focus", refreshTagPermission);
  $("collapse").addEventListener("click", () => {
    preferences.expanded = !preferences.expanded;
    updateExpanded();
    persist();
  });
  $("show").addEventListener("click", () => {
    showHidden = !showHidden;
    process();
  });
  $("reset").addEventListener("click", () => {
    $("query").value = currentKeyword.slice(0, 2000);
    showHidden = false;
    process();
  });
  $("settings").addEventListener("click", () =>
    chrome.runtime?.sendMessage({ op: "openSettings" }),
  );
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title", "href", "class"],
  });
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[globalThis.LensSettings.KEY]?.newValue) {
        try {
          systemSettings = globalThis.LensSettings.validate(
            changes[globalThis.LensSettings.KEY].newValue,
          );
          preferences.enabled = systemSettings.modules.search;
          for (const field of [
            "mode",
            "exclusions",
            "expanded",
            "useVideoTags",
            "fillPages",
          ])
            preferences[field] = systemSettings.search[field];
          $("enabled").checked = preferences.enabled;
          $("video-tags").checked = preferences.useVideoTags;
          $("fill-pages").checked = preferences.fillPages;
          $("mode").value = preferences.mode;
          $("exclusions").value = preferences.exclusions;
          updateExpanded();
          if (!inactive) {
            if (!preferences.enabled || !preferences.useVideoTags)
              stopTagLookups();
            refreshTagPermission();
            process();
            syncMonitoring();
          }
        } catch {}
      }
    });
  }
  // Detect keyword changes on client-side navigation without patching page functions.
  function startNavigationObserver() {
    return setInterval(() => {
      if (location.href !== tagRoute) process();
    }, 700);
  }
  let navigationTimer;
  function syncMonitoring() {
    observer.disconnect();
    clearInterval(navigationTimer);
    clearTimeout(scheduled);
    if (preferences.enabled && !inactive) {
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["title", "href", "class"],
      });
      navigationTimer = startNavigationObserver();
    }
  }
  syncMonitoring();
  window.addEventListener("pagehide", () => {
    inactive = true;
    stopTagLookups();
    refill.destroy();
    pagination?.reset();
    observer.disconnect();
    clearInterval(navigationTimer);
    clearTimeout(scheduled);
    clearTimeout(saveTimer);
    // Flush a pending edit before navigating away from this page.
    storage?.set({ [key]: { ...preferences } }).catch(() => {});
    if (systemSettings) {
      const snapshot = globalThis.LensSettings.copy(systemSettings);
      snapshot.modules.search = preferences.enabled;
      for (const field of [
        "mode",
        "exclusions",
        "expanded",
        "useVideoTags",
        "fillPages",
      ])
        snapshot.search[field] = preferences[field];
      globalThis.LensSettings.save(snapshot, storage).catch(() => {});
    }
    for (const element of marked) restore(element);
    for (const slot of hiddenSlots)
      slot.removeAttribute("data-lens-search-slot-hidden");
    hiddenSlots.clear();
    marked.clear();
    for (const [element, order] of originalOrders) element.style.order = order;
    originalOrders.clear();
  });
  window.addEventListener("pageshow", (event) => {
    // A back/forward-cache restore has no new script injection. Reconnect observation.
    if (event.persisted) {
      inactive = false;
      refreshTagPermission();
      syncMonitoring();
      process();
    }
  });
  process();
  refreshTagPermission();
})();
