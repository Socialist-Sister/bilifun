(function (root) {
  "use strict";
  const KEY = "lensVideoTags",
    TTL = 86400000,
    LIMIT = 300;
  const validId = (id) =>
    typeof id === "string" && /^(BV\w{8,22}|av\d{1,16})$/.test(id);
  const validTags = (tags) =>
    Array.isArray(tags) &&
    tags.length <= 50 &&
    tags.every((tag) => typeof tag === "string" && tag.length <= 100);
  class Tags {
    constructor(fetchTags, storage = root.chrome?.storage?.local) {
      this.fetchTags = fetchTags;
      this.storage = storage;
      this.cache = new Map();
      this.jobs = new Map();
      this.queue = [];
      this.active = 0;
      this.writes = Promise.resolve();
      this.loaded = null;
      this.epoch = 0;
    }
    load() {
      return (this.loaded ||= (async () => {
        const rows = (await this.storage?.get(KEY).catch(() => ({})))?.[KEY];
        if (!Array.isArray(rows)) return;
        for (const row of rows.slice(-LIMIT)) {
          if (
            validId(row?.id) &&
            validTags(row.tags) &&
            Number.isFinite(row.time) &&
            row.time <= Date.now() &&
            Date.now() - row.time < TTL
          )
            this.cache.set(row.id, { tags: row.tags, time: row.time });
        }
      })());
    }
    save() {
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          const rows = [...this.cache]
            .filter(([, row]) => Date.now() - row.time < TTL)
            .slice(-LIMIT)
            .map(([id, row]) => ({ id, ...row }));
          await this.storage?.set({ [KEY]: rows });
        });
      return this.writes.catch(() => {});
    }
    async get(videoId, token, preflight = async () => {}) {
      if (
        !validId(videoId) ||
        typeof token !== "string" ||
        !token ||
        token.length > 250
      )
        throw new Error("标签查询参数无效");
      // Register before reading storage so cancellation also covers queued/loading jobs.
      if (this.jobs.has(token)) throw new Error("标签查询已在进行");
      if (this.jobs.size >= 60) throw new Error("标签查询繁忙，请稍后重试");
      const controller = new AbortController();
      this.jobs.set(token, controller);
      const epoch = this.epoch;
      try {
        await preflight();
        await this.load();
        if (controller.signal.aborted) throw new Error("标签查询已取消");
        const cached = this.cache.get(videoId);
        if (cached && Date.now() - cached.time < TTL) return [...cached.tags];
        const tags = await new Promise((resolve, reject) => {
          const job = { videoId, controller, resolve, reject };
          const cancel = () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) this.queue.splice(index, 1);
            reject(new Error("标签查询已取消"));
          };
          job.cancel = cancel;
          controller.signal.addEventListener("abort", cancel, { once: true });
          this.queue.push(job);
          this.pump();
        });
        if (!validTags(tags)) throw new Error("标签数据无效");
        if (controller.signal.aborted || epoch !== this.epoch)
          throw new Error("标签查询已取消");
        this.cache.delete(videoId);
        this.cache.set(videoId, { tags: [...tags], time: Date.now() });
        while (this.cache.size > LIMIT)
          this.cache.delete(this.cache.keys().next().value);
        await this.save();
        return [...tags];
      } finally {
        this.jobs.delete(token);
      }
    }
    pump() {
      while (this.active < 2 && this.queue.length) {
        const job = this.queue.shift();
        if (job.controller.signal.aborted) continue;
        this.active++;
        // A second caller may have populated the cache while this job waited.
        const cached = this.cache.get(job.videoId);
        Promise.resolve()
          .then(() =>
            cached && Date.now() - cached.time < TTL
              ? [...cached.tags]
              : this.fetchTags(job.videoId, { signal: job.controller.signal }),
          )
          .then(job.resolve, job.reject)
          .finally(() => {
            job.controller.signal.removeEventListener("abort", job.cancel);
            this.active--;
            this.pump();
          });
      }
    }
    cancel(token) {
      this.jobs.get(token)?.abort();
    }
    async clear() {
      this.epoch++;
      for (const controller of this.jobs.values()) controller.abort();
      await this.load();
      this.cache.clear();
      await this.save();
    }
  }
  root.LensTags = Tags;
  if (typeof module !== "undefined" && module.exports) module.exports = Tags;
})(globalThis);
