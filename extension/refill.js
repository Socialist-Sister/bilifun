(function (root) {
  "use strict";
  // User-requested direction: compact existing slots, then fill gaps from at most
  // three subsequent video-search pages with the same server-side conditions.
  function context(url, pageSize = 42) {
    const parsed = new URL(url),
      params = parsed.searchParams;
    if (
      parsed.origin !== "https://search.bilibili.com" ||
      !/^\/(?:all|video)\/?$/.test(parsed.pathname)
    )
      throw new Error("补位仅支持综合 / 视频搜索页");
    const keyword = params.get("keyword") || "",
      page = Number(params.get("page") || 1);
    if (
      !keyword ||
      keyword.length > 200 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 997 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50
    )
      throw new Error("补位搜索词、页码或每页数量超出范围");
    const order = params.get("order") || "totalrank";
    if (
      !["totalrank", "click", "pubdate", "dm", "stow", "scores"].includes(order)
    )
      throw new Error("当前排序暂不支持补位");
    const filters = {};
    for (const [name, max] of [
      ["duration", 4],
      ["tids", 10000],
      ["pubtime_begin_s", 4102444800],
      ["pubtime_end_s", 4102444800],
      ["order_sort", 1],
    ]) {
      if (!params.has(name)) continue;
      const value = Number(params.get(name));
      if (
        !/^\d+$/.test(params.get(name)) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > max
      )
        throw new Error("当前搜索筛选条件暂不支持补位");
      filters[name] = value;
    }
    return { keyword, page, order, pageSize, filters };
  }
  function plain(value, limit) {
    return String(value || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code) => {
        const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (named[code.toLowerCase()]) return named[code.toLowerCase()];
        const n =
          code[1]?.toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : match;
      })
      .slice(0, limit);
  }
  const number = (value) =>
    value !== "" &&
    value !== null &&
    value !== undefined &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
      ? Number(value)
      : undefined;
  function cover(value) {
    try {
      const url = new URL(String(value || "").replace(/^\/\//, "https://"));
      return url.protocol === "https:" &&
        /^(?:[a-z0-9-]+\.)*hdslb\.com$/i.test(url.hostname) &&
        !url.username &&
        !url.password
        ? url.href
        : "";
    } catch {
      return "";
    }
  }
  function normalizePage(data) {
    if (!data || !Array.isArray(data.result) || data.result.length > 100)
      throw new Error("搜索页返回结构不支持补位");
    const rows = data.result
      .slice(0, 50)
      .filter(
        (r) =>
          r && /^BV\w{8,22}$/.test(r.bvid) && (!r.type || r.type === "video"),
      )
      .map((r) => ({
        videoId: r.bvid,
        bvid: r.bvid,
        url: `https://www.bilibili.com/video/${r.bvid}`,
        aliases: [
          r.bvid,
          ...(Number.isSafeInteger(Number(r.aid)) && Number(r.aid) > 0
            ? [`av${r.aid}`]
            : []),
        ],
        title: plain(r.title, 500),
        highlights: [
          ...String(r.title || "").matchAll(
            /<em(?:\s[^>]*)?>([\s\S]*?)<\/em>/gi,
          ),
        ]
          .slice(0, 20)
          .map((m) => plain(m[1], 500))
          .filter(Boolean),
        description: plain(r.description, 2000),
        tags:
          typeof r.tag === "string"
            ? r.tag
                .split(/[,，]/)
                .slice(0, 50)
                .map((t) => plain(t.trim(), 100))
                .filter(Boolean)
            : [],
        uid:
          Number.isSafeInteger(Number(r.mid)) && Number(r.mid) > 0
            ? String(r.mid)
            : undefined,
        author: plain(r.author, 100),
        views: number(r.play),
        danmaku: number(r.video_review ?? r.danmaku),
        pubdate: number(r.pubdate),
        tid:
          Number.isInteger(Number(r.typeid)) && Number(r.typeid) > 0
            ? Number(r.typeid)
            : undefined,
        duration: /^\d+:\d{2}(?::\d{2})?$/.test(String(r.duration))
          ? String(r.duration)
              .split(":")
              .reduce((sum, n) => sum * 60 + Number(n), 0)
          : undefined,
        pic: cover(r.pic),
      }))
      .filter((r) => r.title);
    return {
      rows,
      totalPages: number(data.numPages),
      pageSize: number(data.pagesize ?? data.page_size),
    };
  }
  function countLabel(value) {
    if (value >= 100000000)
      return `${Number((value / 100000000).toFixed(1))}亿`;
    if (value >= 10000) return `${Number((value / 10000).toFixed(1))}万`;
    return String(Math.floor(value));
  }
  function dateLabel(value) {
    if (!value || value > 4102444800) return "";
    const elapsed = Math.max(0, Date.now() / 1000 - value);
    if (elapsed < 60) return "刚刚";
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}分钟前`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}小时前`;
    if (elapsed < 172800) return "昨天";
    if (elapsed < 30 * 86400) return `${Math.floor(elapsed / 86400)}天前`;
    const date = new Date(value * 1000);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  function icon(document, native, kind) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "currentColor");
    // Rebuild only bounded geometry, never clone event handlers, links or HTML.
    const paths = [...(native?.querySelectorAll("path") || [])]
      .slice(0, 12)
      .map((p) => p.getAttribute("d") || "")
      .filter(
        (d) =>
          d.length <= 16000 && /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(d),
      );
    if (
      paths.length &&
      /^\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s*$/.test(
        native.getAttribute("viewBox") || "",
      )
    )
      svg.setAttribute("viewBox", native.getAttribute("viewBox"));
    const fallback =
      kind === "play"
        ? "M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z M10 8l6 4-6 4z"
        : kind === "danmaku"
          ? "M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z M6 9h2v2H6z M10 9h8v2h-8z M6 13h8v2H6z M16 13h2v2h-2z"
          : "M3 3h18v18H3z M5 5v14h14V5z M7 8h2v6h2V8h2v8H7z M14 8h4v5h-2v3h-2z M16 10v1h1v-1z";
    for (const d of paths.length ? paths : [fallback]) {
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  function styleFromNative(sample) {
    const properties = {};
    if (!sample) return properties;
    const view = sample.ownerDocument.defaultView;
    const read = (selector) => {
      const element = selector ? sample.querySelector(selector) : sample;
      return element ? view.getComputedStyle(element) : null;
    };
    const base = read(),
      title = read(
        ".bili-video-card__info--tit, .bili-video-card__info--title, .title",
      ),
      info = read(".bili-video-card__info--bottom"),
      cover = read(".bili-video-card__image"),
      stats = read(".bili-video-card__stats"),
      statIcon = read(".bili-video-card__stats--icon"),
      authorIcon = read(".bili-video-card__info--author-ico"),
      keyword = read(".keyword");
    const set = (name, value) => {
      if (value) properties[`--lens-${name}`] = value;
    };
    set("font", base.fontFamily);
    set("text", base.color);
    if (title) {
      set("title-font", title.fontFamily);
      set("title-size", title.fontSize);
      set("title-weight", title.fontWeight);
      const line = parseFloat(title.lineHeight);
      if (Number.isFinite(line) && line > 0) {
        set("title-line", `${line}px`);
        set("title-height", `${line * 2}px`);
      }
      set("title-padding-right", title.paddingRight);
    }
    if (info) {
      set("info-font", info.fontFamily);
      set("info-size", info.fontSize);
      set("info-line", info.lineHeight);
      set("info-color", info.color);
      set("info-gap", info.marginTop);
    }
    if (cover) set("cover-radius", cover.borderRadius);
    if (stats) {
      set("stats-size", stats.fontSize);
      set("stats-line", stats.lineHeight);
      for (const side of ["Top", "Right", "Bottom", "Left"])
        set(`stats-${side.toLowerCase()}`, stats[`padding${side}`]);
    }
    if (statIcon) set("stats-icon-size", statIcon.height);
    if (authorIcon) set("author-icon-size", authorIcon.height);
    if (keyword) set("keyword-color", keyword.color);
    const nativeInfo = read(".bili-video-card__info");
    if (nativeInfo) set("title-gap", nativeInfo.marginTop);
    return properties;
  }
  function measureSlots(cards) {
    const measurements = new Map();
    // Call while native cards are visible, before applying our hide markers.
    // Hidden flex items with width:auto have no used width; their covers must
    // never become the sizing reference for a supplemental card.
    for (const card of cards) {
      const slot = root.BiliSearchLensAdapter.layoutElement(card.element);
      if (measurements.has(slot)) continue;
      const style = slot.ownerDocument.defaultView.getComputedStyle(slot);
      measurements.set(slot, {
        width: slot.getBoundingClientRect().width,
        marginBottom: style.marginBottom,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      });
    }
    return measurements;
  }
  function createSlot(row, document, sample) {
    const slot = document.createElement("div");
    slot.className = "lens-refill-slot";
    slot.dataset.lensRefillOwned = "true";
    slot.dataset.videoId = row.videoId;
    const card = document.createElement("article");
    card.className = "lens-refill-card";
    const link = document.createElement("a");
    link.href = row.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "lens-refill-cover";
    if (row.pic) {
      const img = document.createElement("img");
      img.src = row.pic;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      link.append(img);
    }
    const stats = document.createElement("div");
    stats.className = "lens-refill-stats";
    const left = document.createElement("div");
    left.className = "lens-refill-stats-left";
    for (const [kind, value, index, label] of [
      ["play", row.views, 0, "播放量"],
      ["danmaku", row.danmaku, 1, "弹幕数"],
    ]) {
      if (!Number.isFinite(value)) continue;
      const item = document.createElement("span");
      item.className = `lens-refill-stat lens-refill-${kind}`;
      item.setAttribute("aria-label", `${label} ${Math.floor(value)}`);
      const native = sample?.querySelectorAll(
        ".bili-video-card__stats--item svg",
      )[index];
      item.append(
        icon(document, native, kind),
        document.createTextNode(countLabel(value)),
      );
      left.append(item);
    }
    stats.append(left);
    if (Number.isFinite(row.duration)) {
      const duration = document.createElement("span");
      duration.className = "lens-refill-duration";
      duration.textContent =
        row.duration >= 3600
          ? `${String(Math.floor(row.duration / 3600)).padStart(2, "0")}:${String(Math.floor(row.duration / 60) % 60).padStart(2, "0")}:${String(Math.floor(row.duration % 60)).padStart(2, "0")}`
          : `${String(Math.floor(row.duration / 60)).padStart(2, "0")}:${String(Math.floor(row.duration % 60)).padStart(2, "0")}`;
      stats.append(duration);
    }
    link.append(stats);
    const title = document.createElement("h3");
    title.className = "lens-refill-title";
    const titleLink = document.createElement("a");
    titleLink.href = row.url;
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
    title.title = row.title;
    let offset = 0;
    while (offset < row.title.length) {
      const match = (row.highlights || [])
        .map((word) => ({
          word,
          index: row.title.toLowerCase().indexOf(word.toLowerCase(), offset),
        }))
        .filter((m) => m.word && m.index >= offset)
        .sort((a, b) => a.index - b.index)[0];
      if (!match) {
        titleLink.append(document.createTextNode(row.title.slice(offset)));
        break;
      }
      titleLink.append(
        document.createTextNode(row.title.slice(offset, match.index)),
      );
      const em = document.createElement("em");
      em.className = "lens-refill-keyword";
      em.textContent = row.title.slice(
        match.index,
        match.index + match.word.length,
      );
      titleLink.append(em);
      offset = match.index + match.word.length;
    }
    title.append(titleLink);
    const info = document.createElement("p");
    info.className = "lens-refill-info";
    if (row.uid) {
      const author = document.createElement("a");
      author.href = `https://space.bilibili.com/${row.uid}`;
      author.target = "_blank";
      author.rel = "noopener noreferrer";
      author.className = "lens-refill-author";
      const name = document.createElement("span");
      name.className = "lens-refill-author-name";
      name.textContent = row.author || "UP 主";
      author.append(
        icon(
          document,
          sample?.querySelector(".bili-video-card__info--author-ico"),
          "up",
        ),
        name,
      );
      info.append(author);
    } else info.textContent = row.author;
    const published = dateLabel(row.pubdate);
    if (published) {
      const date = document.createElement("span");
      date.className = "lens-refill-date";
      date.textContent = `${row.author || row.uid ? " · " : ""}${published}`;
      info.append(date);
    }
    card.append(link, title, info);
    slot.append(card);
    return slot;
  }
  class Controller {
    constructor(request, changed) {
      this.request = request;
      this.changed = changed;
      this.sequence = 0;
      this.generation = 0;
      this.nodes = new Map();
      this.pool = [];
      this.items = [];
      this.pages = 0;
      this.attempts = 0;
      this.error = "";
      this.status = "";
    }
    cancel() {
      this.generation++;
      this.abort?.abort();
      this.abort = null;
      this.running = false;
    }
    remove() {
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
      this.items = [];
    }
    reset() {
      this.cancel();
      this.remove();
      this.pool = [];
      this.pages = 0;
      this.attempts = 0;
      this.error = "";
      this.paused = false;
      this.exhausted = false;
    }
    stop() {
      this.paused = true;
      this.cancel();
    }
    retry() {
      this.cancel();
      this.paused = false;
      this.error = "";
      this.attempts = this.pages;
    }
    destroy() {
      this.reset();
      this.key = "";
      this.container = null;
    }
    update(args) {
      const groups = new Map();
      for (const entry of args.entries) {
        const slot = root.BiliSearchLensAdapter.layoutElement(
            entry.card.element,
          ),
          parent = slot.parentElement;
        if (!parent) continue;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push({ ...entry, slot });
      }
      const group = [...groups].sort((a, b) => b[1].length - a[1].length)[0],
        container = group?.[0];
      if (this.key !== args.url || this.container !== container) {
        this.reset();
        this.key = args.url;
        this.container = container;
      }
      this.args = args;
      this.group = group?.[1] || [];
      if (!args.enabled) {
        this.cancel();
        this.remove();
        this.status = "跨页补位已暂停；当前页仍会紧凑排列。";
        return;
      }
      if (
        !container ||
        !/^(flex|grid|inline-flex|inline-grid)$/.test(
          container.ownerDocument.defaultView.getComputedStyle(container)
            .display,
        )
      ) {
        this.cancel();
        this.remove();
        this.status = "当前视频布局暂不支持跨页补位。";
        return;
      }
      const rawSlots = [...container.children].filter(
        (n) =>
          !n.hasAttribute("data-lens-refill-owned") &&
          (n.matches(root.BiliSearchLensAdapter.CARD_SELECTOR) ||
            n.querySelector(root.BiliSearchLensAdapter.CARD_SELECTOR)),
      );
      try {
        const next = context(args.url, rawSlots.length);
        // A changed page size changes every subsequent page's result offset.
        // Do not mix candidates or pending responses from different partitions.
        if (this.context && this.context.pageSize !== next.pageSize)
          this.reset();
        this.context = next;
      } catch (error) {
        this.status = error.message;
        this.cancel();
        this.remove();
        return;
      }
      const target = this.group.length,
        nativeKept = this.group.filter((e) => e.keep).length;
      const seen = new Set(
          args.entries.map((e) => e.card.videoId).filter(Boolean),
        ),
        selected = [];
      for (const row of this.pool) {
        if (
          row.aliases.some((id) => seen.has(id)) ||
          row.aliases.some((id) => args.blocked?.(id)) ||
          !root.BiliSearchLens.evaluateVideo(row, args.rules, args.options).keep
        )
          continue;
        row.aliases.forEach((id) => seen.add(id));
        selected.push(row);
        if (selected.length >= target - nativeKept) break;
      }
      if (target - nativeKept <= 0) selected.length = 0;
      const wanted = new Set(selected.map((r) => r.videoId));
      for (const [id, node] of this.nodes)
        if (!wanted.has(id)) {
          node.remove();
          this.nodes.delete(id);
        }
      const sample =
        this.group.find((e) => e.keep)?.slot || this.group[0]?.slot;
      const style =
        args.nativeLayout?.get(sample) ||
        container.ownerDocument.defaultView.getComputedStyle(sample);
      const nativeSample =
        this.group.find((e) => e.card.videoId && e.keep)?.card.element ||
        this.group.find((e) => e.card.videoId)?.card.element;
      const iconSample =
        this.group.find(
          (e) =>
            e.card.videoId &&
            e.card.element.querySelectorAll(".bili-video-card__stats--item svg")
              .length >= 2 &&
            e.card.element.querySelector(".bili-video-card__info--author-ico"),
        )?.card.element || nativeSample;
      const nativeStyles = styleFromNative(nativeSample);
      const flex = /flex/.test(
        container.ownerDocument.defaultView.getComputedStyle(container).display,
      );
      const width =
        style.width > 0 ? style.width : sample.getBoundingClientRect().width;
      if (flex && (!Number.isFinite(width) || width <= 0)) {
        this.remove();
        this.status = "等待原生视频列宽可测量后补位；可调整窗口或刷新页面。";
        return;
      }
      for (const row of selected) {
        let node = this.nodes.get(row.videoId);
        if (!node) {
          node = createSlot(row, container.ownerDocument, iconSample);
          this.nodes.set(row.videoId, node);
        }
        if (node.parentElement !== container) container.append(node);
        for (const [name, value] of Object.entries(nativeStyles))
          node.style.setProperty(name, value);
        node.style.marginBottom = style.marginBottom;
        if (flex) {
          node.style.width = `${width}px`;
          node.style.maxWidth = `${width}px`;
          node.style.flexBasis = `${width}px`;
          node.style.flexGrow = "0";
          node.style.flexShrink = "0";
          node.style.paddingLeft = style.paddingLeft;
          node.style.paddingRight = style.paddingRight;
        } else {
          for (const property of [
            "width",
            "maxWidth",
            "flexBasis",
            "flexGrow",
            "flexShrink",
          ])
            node.style[property] = "";
        }
      }
      // Restore pool order after rule edits, moving only out-of-order nodes.
      // Unconditional append would cause our MutationObserver to run forever.
      let anchor = null;
      for (const row of [...selected].reverse()) {
        const node = this.nodes.get(row.videoId);
        let next = node.nextElementSibling;
        while (next && !next.hasAttribute("data-lens-refill-owned"))
          next = next.nextElementSibling;
        if (next !== anchor) container.insertBefore(node, anchor);
        anchor = node;
      }
      this.items = selected.map((row) => ({
        ...row,
        element: this.nodes.get(row.videoId),
      }));
      const gap = Math.max(0, target - nativeKept - selected.length),
        prefix = `已补 ${selected.length} 个视频 · 已读取后续 ${this.pages} 页`;
      if (!gap) {
        this.cancel();
        this.status = args.waiting
          ? `${prefix} · ${args.waitReason || "等待当前页标签核对后补位"}`
          : `${prefix} · 当前视频列表已补齐`;
        return;
      }
      if (this.paused) {
        this.status = `${prefix} · 已停止补位`;
        return;
      }
      if (args.waiting) {
        this.status = `${prefix} · ${args.waitReason || "等待当前页标签核对后补位"}`;
        return;
      }
      if (!args.permission) {
        this.cancel();
        this.status =
          "跨页补位需要数据接口授权；点击“授权 / 设置标签查询”使用同一权限。";
        return;
      }
      if (this.error) {
        this.status = `${prefix} · 补位失败：${this.error}`;
        return;
      }
      if (this.exhausted || this.attempts >= 3 || this.pool.length >= 150) {
        this.status = `${prefix} · ${this.exhausted ? "已到结果末尾" : "已达 3 页查询上限"}，仍缺 ${gap} 个`;
        return;
      }
      this.status = `${prefix} · 正在从第 ${this.context.page + this.pages + 1} 页补位`;
      if (!this.running) this.fetchPage();
    }
    async fetchPage() {
      this.running = true;
      this.attempts++;
      const generation = this.generation,
        requestContext = this.context,
        requestUrl = this.key,
        page = requestContext.page + this.pages + 1;
      const abort = new AbortController();
      this.abort = abort;
      try {
        const data = await this.request(
          {
            op: "refillPage",
            url: requestUrl,
            page,
            pageSize: requestContext.pageSize,
            token: `refill-${++this.sequence}`,
          },
          { signal: abort.signal },
        );
        if (generation !== this.generation) return;
        if (!data || !Array.isArray(data.rows) || data.rows.length > 50)
          throw new Error("补位响应结构不支持");
        if (data.pageSize && data.pageSize !== requestContext.pageSize)
          throw new Error("接口每页数量与当前页不同，已停止以避免错页");
        this.pool.push(
          ...data.rows.map((row) => ({ ...row, sourcePage: page })),
        );
        this.pages++;
        this.exhausted =
          !data.rows.length || (data.totalPages && page >= data.totalPages);
      } catch (error) {
        if (generation === this.generation && error.name !== "AbortError")
          this.error = String(error.message)
            .replace(/https?:\/\/\S+/g, "[地址已隐藏]")
            .slice(0, 200);
      } finally {
        if (generation === this.generation) {
          this.running = false;
          this.abort = null;
          this.changed();
        }
      }
    }
  }
  root.LensRefill = Object.freeze({
    context,
    normalizePage,
    measureSlots,
    Controller,
  });
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.LensRefill;
})(globalThis);
