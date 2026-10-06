(function (root) {
  "use strict";
  const KEY = "lensSearchPagesV1",
    TTL = 4 * 60 * 60 * 1000;
  const validId = (id) =>
    typeof id === "string" && /^(?:BV\w{8,22}|av\d{1,16})$/.test(id);
  // Only public identifiers and their owning page are stored. No query text,
  // titles or video URLs are written to session storage.
  class Store {
    constructor(storage, now = Date.now) {
      this.storage = storage;
      this.now = now;
      this.queue = Promise.resolve();
      this.closed = new Set();
    }
    run(tabId, scope, page, ids) {
      const action = async () => {
        if (this.closed.has(tabId)) throw new Error("标签页已关闭");
        if (
          !Number.isInteger(tabId) ||
          tabId < 0 ||
          !/^[a-f0-9]{64}$/.test(scope) ||
          !Number.isInteger(page) ||
          page < 1 ||
          page > 997 ||
          (ids !== undefined &&
            (!Array.isArray(ids) || ids.length > 200 || !ids.every(validId)))
        )
          throw new Error("分页记录格式无效");
        const data = (await this.storage.get(KEY))[KEY] || {},
          now = this.now();
        for (const [id, state] of Object.entries(data))
          if (now - state.updated > TTL) delete data[id];
        let state = data[tabId];
        if (!state || state.scope !== scope) {
          if (ids !== undefined) throw new Error("分页条件已变更，请重新读取");
          state = { scope, updated: now, owners: {} };
          data[tabId] = state;
        }
        if (ids !== undefined) {
          const added = ids.filter((id) => !state.owners[id]);
          if (Object.keys(state.owners).length + new Set(added).size > 10000)
            throw new Error("分页去重记录已达上限，请重新开始搜索");
          for (const id of ids) if (!state.owners[id]) state.owners[id] = page;
        }
        state.updated = now;
        // Bound identifiers globally, leaving generous space for storage's
        // in-memory object overhead. Preserve the currently active tab.
        const tabs = Object.keys(data)
          .filter((id) => Number(id) !== tabId)
          .sort((a, b) => data[b].updated - data[a].updated);
        let total = Object.keys(state.owners).length;
        for (let index = 0; index < tabs.length; index++) {
          const id = tabs[index],
            count = Object.keys(data[id].owners).length;
          if (index >= 19 || total + count > 20000) delete data[id];
          else total += count;
        }
        await this.storage.set({ [KEY]: data });
        return { ...state.owners };
      };
      const result = this.queue.then(action);
      this.queue = result.catch(() => {});
      return result;
    }
    remove(tabId) {
      this.closed.add(tabId);
      const result = this.queue.then(async () => {
        const data = (await this.storage.get(KEY))[KEY] || {};
        delete data[tabId];
        await this.storage.set({ [KEY]: data });
      });
      this.queue = result.catch(() => {});
      return result;
    }
  }
  class Client {
    constructor(request, changed) {
      this.request = request;
      this.changed = changed;
      this.owners = {};
      this.generation = 0;
    }
    prepare(url, pageSize, rules, useVideoTags) {
      let context;
      try {
        context = root.LensRefill.context(url, pageSize);
      } catch {
        this.reset();
        return;
      }
      const rule = JSON.stringify({ rules, useVideoTags }),
        parsed = new URL(url),
        scope = JSON.stringify({
          path: parsed.pathname.replace(/\/$/, ""),
          ...context,
          page: undefined,
          rule,
        }),
        route = `${scope}:${context.page}`;
      if (route === this.route) return;
      this.reset();
      this.route = route;
      this.page = context.page;
      this.message = { op: "searchPageRecord", url, pageSize, rule };
      this.pending = true;
      const generation = this.generation;
      this.request(this.message, { timeout: 5000 })
        .then((owners) => {
          if (generation !== this.generation) return;
          this.owners = owners;
          this.ready = true;
        })
        .catch((error) => {
          if (generation === this.generation) this.error = error.message;
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.pending = false;
          this.changed();
        });
    }
    reset() {
      this.generation++;
      this.route = "";
      this.owners = {};
      this.ready = false;
      this.pending = false;
      this.error = "";
      this.signature = "";
      this.saving = false;
    }
    owner(id) {
      return this.owners[id];
    }
    blocked(id) {
      return !!this.owner(id) && this.owner(id) !== this.page;
    }
    commit(ids) {
      if (!this.ready || this.saving || this.error) return;
      ids = [...new Set(ids.filter(validId))].slice(0, 200).sort();
      const signature = JSON.stringify(ids);
      if (signature === this.signature) return;
      this.signature = signature;
      this.saving = true;
      const generation = this.generation;
      this.request({ ...this.message, ids }, { timeout: 5000 })
        .then((owners) => {
          if (generation === this.generation) this.owners = owners;
        })
        .catch((error) => {
          if (generation === this.generation) this.error = error.message;
        })
        .finally(() => {
          if (generation === this.generation) {
            this.saving = false;
            this.changed();
          }
        });
    }
  }
  root.LensPagination = Object.freeze({ Store, Client, KEY, TTL });
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.LensPagination;
})(globalThis);
