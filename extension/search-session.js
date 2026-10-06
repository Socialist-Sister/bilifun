/* Independent search owns one bounded candidate pool and its own pagination.
 * Missing lexical clues mean uncertain, never automatic semantic rejection. */
(function (root) {
  "use strict";
  const core =
    root.BiliSearchLens ||
    (typeof require === "function" ? require("./core.js") : null);
  const LIMIT = 1000,
    MAX_PAGES = 20;
  class Session {
    constructor(request, changed = () => {}) {
      this.request = request;
      this.changed = changed;
      this.generation = 0;
      this.pool = [];
      this.queries = [];
      this.seen = new Set();
      this.hidden = new Set();
      this.loading = false;
      this.pages = 0;
      this.error = "";
      this.keyword = "";
      this.batchIndex = 0;
    }
    start(keyword, variants = [], order = "totalrank") {
      const queries = [
        ...new Set(
          [keyword, ...variants].map((q) => String(q).trim()).filter(Boolean),
        ),
      ];
      if (
        !String(keyword).trim() ||
        queries.length > 3 ||
        queries.some((q) => q.length > 200) ||
        !["totalrank", "pubdate", "click"].includes(order)
      )
        throw new Error("请输入 1–200 字搜索词，最多添加两种查询写法");
      const rules = core.compileRules(keyword, "", "related");
      if (rules.error) throw new Error(rules.error);
      this.stop();
      this.keyword = keyword.trim();
      this.order = order;
      this.rules = rules;
      this.queries = queries.map((keyword) => ({
        keyword,
        nextPage: 1,
        done: false,
      }));
      this.pool = [];
      this.seen.clear();
      this.hidden.clear();
      this.pages = 0;
      this.error = "";
      this.batchIndex = 0;
      this.changed();
    }
    get hasMore() {
      return (
        this.pool.length < LIMIT &&
        this.queries.some((q) => !q.done && q.nextPage <= MAX_PAGES)
      );
    }
    assess(row) {
      const result = core.evaluateVideo(row, this.rules);
      return result.keep && result.relevance === "relevant"
        ? {
            clue: "matched",
            reason: "标题、简介或标签中发现关键词 / 型号线索；仍可查看内容确认",
          }
        : {
            clue: "uncertain",
            reason: "现有文字线索不足，保留待确认；未据此判断无关",
          };
    }
    async load() {
      if (this.loading || !this.hasMore) return;
      const generation = this.generation,
        controller = new AbortController();
      this.controller = controller;
      this.loading = true;
      this.error = "";
      this.changed();
      try {
        while (this.batchIndex < this.queries.length) {
          const query = this.queries[this.batchIndex];
          if (generation !== this.generation || !this.hasMore) break;
          if (query.done || query.nextPage > MAX_PAGES) {
            this.batchIndex++;
            continue;
          }
          const data = await this.request(
            {
              op: "searchPage",
              keyword: query.keyword,
              page: query.nextPage,
              order: this.order,
              token: `search:${generation}:${query.nextPage}:${this.queries.indexOf(query)}:${Date.now()}`,
            },
            { signal: controller.signal },
          );
          if (generation !== this.generation) return;
          if (!data || !Array.isArray(data.rows) || data.rows.length > 50)
            throw new Error("搜索结果结构无效，请重试");
          for (const row of data.rows) {
            if (!row || !/^BV\w{8,22}$/.test(row.bvid) || !row.title) continue;
            const aliases = [
              row.bvid,
              ...(row.aliases || []).filter((id) =>
                /^(BV\w{8,22}|av\d{1,16})$/.test(id),
              ),
            ];
            if (aliases.some((id) => this.seen.has(id))) continue;
            if (this.pool.length >= LIMIT) break;
            aliases.forEach((id) => this.seen.add(id));
            this.pool.push({ ...row, ...this.assess(row) });
          }
          this.pages++;
          query.nextPage++;
          query.done =
            data.rawCount === 0 ||
            (Number.isFinite(data.totalPages) &&
              data.totalPages >= 0 &&
              query.nextPage > data.totalPages) ||
            query.nextPage > MAX_PAGES;
          this.batchIndex++;
          this.changed();
        }
        if (this.batchIndex === this.queries.length) this.batchIndex = 0;
      } catch (error) {
        if (generation === this.generation && error.name !== "AbortError")
          this.error = error.message;
      } finally {
        if (generation === this.generation) {
          this.loading = false;
          this.controller = null;
          this.changed();
        }
      }
    }
    stop() {
      this.generation++;
      this.controller?.abort();
      this.controller = null;
      this.loading = false;
      this.changed();
    }
    toggleHidden(bvid) {
      if (this.hidden.has(bvid)) this.hidden.delete(bvid);
      else this.hidden.add(bvid);
      this.changed();
    }
    updateTags(bvid, tags) {
      const row = this.pool.find((r) => r.bvid === bvid);
      if (!row) return;
      row.tags = [
        ...new Set([
          ...(row.tags || []),
          ...tags
            .filter((t) => typeof t === "string")
            .slice(0, 50)
            .map((t) => t.slice(0, 100)),
        ]),
      ].slice(0, 50);
      Object.assign(row, this.assess(row));
      this.changed();
    }
    selected(filter = "all", exclusions = "") {
      const rules = core.compileRules("", exclusions, "all");
      if (rules.error) throw new Error(rules.error);
      return this.pool
        .map((row) => {
          const result = core.evaluate(row.title, rules);
          const hiddenReason = this.hidden.has(row.bvid)
            ? "本次手动隐藏"
            : !result.keep
              ? result.reason
              : "";
          return { ...row, hiddenReason };
        })
        .filter((row) =>
          filter === "hidden"
            ? row.hiddenReason
            : !row.hiddenReason && (filter === "all" || row.clue === filter),
        );
    }
  }
  root.LensSearch = Object.freeze({ Session, LIMIT, MAX_PAGES });
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.LensSearch;
})(globalThis);
