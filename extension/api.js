(function (root) {
  "use strict";
  class Api {
    constructor(fetcher = root.fetch.bind(root)) {
      this.fetcher = fetcher;
      this.keys = null;
      this.controllers = new Map();
    }
    cancel(token) {
      this.controllers.get(token)?.abort();
    }
    async request(path, params = {}, options = {}) {
      if (!/^\/x\/[\w/-]+(?:\.so)?$/.test(path))
        throw new Error("不支持的接口路径");
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 20000);
      const abort = () => controller.abort();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      if (options.token) this.controllers.set(options.token, controller);
      try {
        const query = options.signed
          ? await this.signature(params, controller.signal)
          : new URLSearchParams(params).toString();
        if (controller.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await this.fetcher(
              `https://api.bilibili.com${path}?${query}`,
              { credentials: "include", signal: controller.signal },
            );
            if (!(response.status >= 500) || attempt === 1) break;
            await response.body?.cancel();
          } catch (error) {
            if (
              error.name === "AbortError" ||
              !(error instanceof TypeError) ||
              attempt === 1
            )
              throw error;
          }
          await new Promise((resolve, reject) => {
            if (controller.signal.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            const cancelled = () => {
              clearTimeout(delay);
              reject(new DOMException("Aborted", "AbortError"));
            };
            const delay = setTimeout(() => {
              controller.signal.removeEventListener("abort", cancelled);
              resolve();
            }, 500);
            controller.signal.addEventListener("abort", cancelled, {
              once: true,
            });
          });
        }
        if (!response.ok)
          throw new Error(
            response.status === 412
              ? "B 站风控拦截，请稍后重试或在 B 站网页完成验证"
              : `接口 HTTP ${response.status}`,
          );
        if (options.binary) {
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > 16 * 1024 * 1024)
            throw new Error("弹幕分包超过 16 MB");
          return buffer;
        }
        const json = await response.json();
        if (json.code !== 0 && !options.nav) {
          const descriptions = {
            "-101": "需要在 B 站网页登录",
            "-10403": "当前账号无权获取该资源",
            "-403": "当前账号或请求无权获取该资源",
            "-404": "视频或资源不存在",
            "-412": "B 站风控拦截，请在站点完成验证后再试",
          };
          throw new Error(
            descriptions[String(json.code)] ||
              `B 站接口返回 ${json.code ?? "未知结构"}`,
          );
        }
        if (!json.data || typeof json.data !== "object")
          throw new Error("接口未返回有效数据");
        return json.data;
      } catch (error) {
        if (error.name === "AbortError") throw new Error("请求已取消或超时");
        throw error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (options.token && this.controllers.get(options.token) === controller)
          this.controllers.delete(options.token);
      }
    }
    async signature(params, signal) {
      if (!this.keys || Date.now() - this.keys.time > 300000) {
        const nav = await this.request(
          "/x/web-interface/nav",
          {},
          { nav: true, signal },
        );
        const keys = nav.wbi_img;
        if (!keys) throw new Error("站点未返回签名信息，请打开 B 站网页重试");
        this.keys = {
          img: new URL(keys.img_url).pathname.split("/").pop().split(".")[0],
          sub: new URL(keys.sub_url).pathname.split("/").pop().split(".")[0],
          time: Date.now(),
        };
      }
      return root.LensWbi.sign(params, this.keys.img, this.keys.sub);
    }
    async view(id, options = {}) {
      if (!/^(BV\w{8,22}|av\d{1,16})$/.test(id))
        throw new Error("视频 ID 无效");
      return root.LensMedia.normalizeView(
        await this.request(
          "/x/web-interface/view",
          id.startsWith("av") ? { aid: id.slice(2) } : { bvid: id },
          options,
        ),
      );
    }
    async streams(bvid, cid, qn = 80, options = {}) {
      return root.LensMedia.normalizeStreams(
        await this.request(
          "/x/player/wbi/playurl",
          {
            bvid,
            cid,
            qn,
            fnval: 4048,
            fnver: 0,
            fourk: 1,
            force_host: 2,
            platform: "pc",
            otype: "json",
          },
          { ...options, signed: true },
        ),
      );
    }
    async tags(videoId, options = {}) {
      if (!/^(BV\w{8,22}|av\d{1,16})$/.test(videoId))
        throw new Error("视频 ID 无效");
      const rows = await this.request(
        "/x/tag/archive/tags",
        videoId.startsWith("av")
          ? { aid: videoId.slice(2) }
          : { bvid: videoId },
        options,
      );
      if (
        !Array.isArray(rows) ||
        rows.some((row) => typeof row?.tag_name !== "string")
      )
        throw new Error("标签接口返回格式异常");
      return [
        ...new Set(
          rows
            .slice(0, 50)
            .map((row) => row.tag_name.trim().slice(0, 100))
            .filter(Boolean),
        ),
      ];
    }
    async player(bvid, cid, options = {}) {
      return this.request(
        "/x/player/wbi/v2",
        { bvid, cid },
        { ...options, signed: true },
      );
    }
    async segment(cid, index, token) {
      return root.LensDanmaku.decode(
        await this.request(
          "/x/v2/dm/wbi/web/seg.so",
          { type: 1, oid: cid, segment_index: index },
          { signed: true, binary: true, token },
        ),
      );
    }
    async subtitle(url) {
      const safe = root.LensMedia.safeUrl(url, true);
      const response = await this.fetcher(safe, {
        credentials: "omit",
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`字幕 HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 5 * 1024 * 1024) throw new Error("字幕超过 5 MB");
      return JSON.parse(text);
    }
    async refillPage(context, page, options = {}) {
      if (
        !Number.isInteger(page) ||
        page <= context.page ||
        page > context.page + 3
      )
        throw new Error("补位只能读取当前页之后的 3 页");
      return root.LensRefill.normalizePage(
        await this.request(
          "/x/web-interface/wbi/search/type",
          {
            search_type: "video",
            keyword: context.keyword,
            page,
            page_size: context.pageSize,
            order: context.order,
            ...context.filters,
          },
          { ...options, signed: true },
        ),
      );
    }
    async searchPage(keyword, page, order, options = {}) {
      if (
        typeof keyword !== "string" ||
        !keyword.trim() ||
        keyword.length > 200 ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > 20 ||
        !["totalrank", "pubdate", "click"].includes(order)
      )
        throw new Error("独立搜索条件超出范围");
      const data = await this.request(
        "/x/web-interface/wbi/search/type",
        {
          search_type: "video",
          keyword: keyword.trim(),
          page,
          page_size: 20,
          order,
        },
        { ...options, signed: true },
      );
      return {
        ...root.LensRefill.normalizePage(data),
        rawCount: data.result.length,
      };
    }
    async search(keyword, page, order) {
      if (
        !keyword ||
        keyword.length > 200 ||
        page < 1 ||
        page > 5 ||
        !["totalrank", "pubdate", "click"].includes(order)
      )
        throw new Error("检索条件超出范围");
      const data = await this.request(
        "/x/web-interface/wbi/search/type",
        { search_type: "video", keyword, page, order },
        { signed: true },
      );
      return (data.result || [])
        .slice(0, 50)
        .map((r) => ({
          bvid: r.bvid,
          title: String(r.title || "").replace(/<[^>]*>/g, ""),
          description: String(r.description || "")
            .replace(/<[^>]*>/g, "")
            .slice(0, 2000),
          tags:
            typeof r.tag === "string"
              ? r.tag
                  .split(/[,，]/)
                  .slice(0, 20)
                  .map((tag) => tag.slice(0, 100))
              : [],
          author: String(r.author || ""),
          mid: r.mid,
          pubdate: r.pubdate,
          play: r.play,
          duration: /^\d+:\d{2}(?::\d{2})?$/.test(String(r.duration))
            ? String(r.duration)
                .split(":")
                .reduce((sum, value) => sum * 60 + Number(value), 0)
            : undefined,
          tid:
            Number.isInteger(Number(r.typeid)) && Number(r.typeid) > 0
              ? Number(r.typeid)
              : undefined,
        }))
        .filter((r) => /^BV\w+$/.test(r.bvid));
    }
  }
  root.LensApi = Api;
  if (typeof module !== "undefined" && module.exports) module.exports = Api;
})(globalThis);
