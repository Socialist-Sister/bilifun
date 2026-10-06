/* Ordinary-video adapters. Every mutation has a matching disposer. */
(async function () {
  "use strict";
  if (globalThis.__lensSite) return;
  globalThis.__lensSite = true;
  let settings,
    route = "",
    videoNode = null,
    currentView = null,
    generation = 0;
  let disposers = [],
    host = null,
    stopped = false,
    overlayActive = false,
    browsingObserver = null;
  const browseHidden = new Set();
  const request = async (op, params = {}) => {
    const reply = await chrome.runtime.sendMessage({ op, ...params });
    if (!reply?.ok) throw new Error(reply?.error || "扩展后台未响应");
    return reply.result;
  };
  function restoreBrowsing() {
    for (const card of browseHidden)
      card.removeAttribute("data-lens-browse-hidden");
    browseHidden.clear();
  }
  function filterBrowsing() {
    restoreBrowsing();
    if (!settings.modules.browsing) return;
    const rules = BiliSearchLens.compileRules("", "", "all", settings.search);
    for (const card of BiliSearchLensAdapter.collectCards(document)) {
      const decision = BiliSearchLens.evaluateVideo(
        card,
        rules,
        settings.search,
      );
      if (!decision.keep) {
        card.element.setAttribute("data-lens-browse-hidden", "true");
        browseHidden.add(card.element);
      }
    }
  }
  function stopVideo() {
    generation++;
    currentView = null;
    overlayActive = false;
    for (const dispose of disposers.splice(0).reverse()) dispose();
    host?.remove();
    host = null;
    videoNode = null;
  }
  function hideSections() {
    const selectors = {
      related: ".right-container .recommend-list-v1,.recommend-list-v1",
      hotSearch: ".trending",
      comments: "#comment,#commentapp",
    };
    for (const section of settings.hiddenSections)
      for (const element of document.querySelectorAll(selectors[section])) {
        const original = element.style.getPropertyValue("display"),
          priority = element.style.getPropertyPriority("display");
        element.style.setProperty("display", "none", "important");
        disposers.push(() => {
          if (element.style.display === "none")
            original
              ? element.style.setProperty("display", original, priority)
              : element.style.removeProperty("display");
        });
      }
  }
  function playerControls(video) {
    const originalRate = video.playbackRate;
    let ownRate = null;
    if (settings.player.rememberRate) {
      video.playbackRate = settings.player.rate;
      ownRate = settings.player.rate;
    }
    const rateChanged = () => {
      if (!settings.player.rememberRate || !Number.isFinite(video.playbackRate))
        return;
      if (video.playbackRate !== ownRate) ownRate = null;
      if (settings.player.rate === video.playbackRate) return;
      settings.player.rate = video.playbackRate;
      LensSettings.save(settings).catch(() => {});
    };
    const keyboard = (event) => {
      if (
        !settings.player.shortcuts ||
        event.defaultPrevented ||
        event.ctrlKey ||
        !event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        event.repeat ||
        event
          .composedPath()
          .some((el) =>
            el?.matches?.(
              "input,textarea,select,[contenteditable='true'],button,a",
            ),
          )
      )
        return;
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const active = document.activeElement;
      if (
        active?.closest?.(".bpx-player-container") ||
        video.matches(":hover")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        video.currentTime = Math.max(
          0,
          Math.min(
            Number.isFinite(video.duration) ? video.duration : 86400,
            video.currentTime +
              (event.key === "ArrowRight" ? 1 : -1) *
                settings.player.seekSeconds,
          ),
        );
      }
    };
    video.addEventListener("ratechange", rateChanged);
    window.addEventListener("keydown", keyboard, true);
    disposers.push(() => {
      video.removeEventListener("ratechange", rateChanged);
      window.removeEventListener("keydown", keyboard, true);
      if (ownRate !== null && video.playbackRate === ownRate)
        video.playbackRate = originalRate;
    });
  }
  function filterOnline(rows, rules) {
    if (rules.regex?.length)
      throw new Error("含正则的规则请使用工具页离线过滤；在线层暂不支持正则");
    return LensDanmaku.filter(rows, rules).kept;
  }
  async function startOverlay(video, label, token) {
    const area = video.closest(".bpx-player-video-area"),
      dm = area?.querySelector(
        ".bpx-player-render-dm-wrap,.bpx-player-dm-wrap",
      );
    if (!dm || !area || !area.contains(dm))
      throw new Error("未识别可恢复的原生弹幕层，请使用工具页离线过滤");
    const parsed = LensMedia.videoFromUrl(location.href),
      info = await request("view", { id: parsed.id });
    if (generation !== token) return;
    const part = info.pages.find((p) => p.page === parsed.page);
    if (!part) throw new Error("未识别当前分 P");
    currentView = { bvid: info.bvid, cid: part.cid };
    const rules = LensSettings.forVideo(settings, info.bvid, info.owner.mid);
    if (rules.regex.length)
      throw new Error("含正则的规则请使用工具页离线过滤；在线层暂不支持正则");
    const layer = document.createElement("div");
    layer.setAttribute("data-lens-overlay", "true");
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "11",
      contain: "layout paint",
    });
    const originalVisibility = dm.style.visibility,
      originalPosition = area.style.position;
    if (getComputedStyle(area).position === "static")
      area.style.position = "relative";
    dm.style.visibility = "hidden";
    area.append(layer);
    overlayActive = true;
    let raf = 0,
      disposed = false,
      lastTime = -1,
      rendered = [],
      next = 0,
      source = [],
      failed = false,
      loading = false,
      fetched = new Set(),
      packets = new Map(),
      active = [];
    const controllers = new Set(),
      lanes = [];
    const clear = () => {
      active = [];
      lanes.length = 0;
      layer.replaceChildren();
      lastTime = -1;
    };
    const dispose = () => {
      disposed = true;
      cancelAnimationFrame(raf);
      layer.remove();
      overlayActive = false;
      for (const requestToken of controllers)
        request("cancelRequest", { token: requestToken }).catch(() => {});
      if (dm.style.visibility === "hidden")
        dm.style.visibility = originalVisibility;
      if (area.style.position === "relative" && !originalPosition)
        area.style.removeProperty("position");
    };
    disposers.push(dispose);
    const refreshRows = () => {
      const available = LensDanmaku.dedupe([...packets.values()].flat()).filter(
        (row) => row.progress >= Math.max(0, video.currentTime - 360) * 1000,
      );
      source = available.slice(0, 40000);
      rendered = filterOnline(source, rules).filter((row) =>
        [1, 2, 3, 4, 5, 6].includes(row.mode),
      );
      return available.length > source.length;
    };
    const fetchSegment = async (index) => {
      if (
        loading ||
        fetched.has(index) ||
        index > Math.ceil(part.duration / 360) ||
        index > 200 ||
        failed
      )
        return;
      fetched.add(index);
      loading = true;
      const requestToken = `overlay:${token}:${index}`;
      controllers.add(requestToken);
      try {
        const data = await request("segment", {
          cid: part.cid,
          index,
          token: requestToken,
        });
        if (disposed || token !== generation) return;
        packets.set(index, data);
        const currentIndex = Math.floor(video.currentTime / 360) + 1;
        while (packets.size > 3) {
          const farthest = [...packets.keys()].sort(
            (a, b) => Math.abs(b - currentIndex) - Math.abs(a - currentIndex),
          )[0];
          packets.delete(farthest);
          fetched.delete(farthest);
        }
        const truncated = refreshRows();
        if (disposed || token !== generation) return;
        clear();
        label.textContent = `自有弹幕：缓存 ${fetched.size} 段，已载入普通类型${truncated ? " · 超限仅保留前 40000 条" : ""} · 工具页可导出原始数据`;
      } catch (error) {
        if (disposed || token !== generation) return;
        failed = true;
        label.textContent = `弹幕层已恢复：${error.message}`;
        dispose();
      } finally {
        loading = false;
        controllers.delete(requestToken);
      }
    };
    function position(comment, time) {
      const elapsed = (time - comment.start) / comment.duration;
      const width = layer.clientWidth;
      const x =
        comment.mode === 6
          ? -comment.width + elapsed * (width + comment.width)
          : width - elapsed * (width + comment.width);
      comment.element.style.transform = [4, 5].includes(comment.mode)
        ? `translateX(${Math.max(0, (width - comment.width) / 2)}px)`
        : `translateX(${x}px)`;
    }
    const tick = () => {
      if (disposed || token !== generation) return;
      const time = video.currentTime;
      if (lastTime < 0 || time < lastTime || time - lastTime > 1) {
        refreshRows();
        clear();
        next = rendered.findIndex(
          (row) => row.progress >= (time - 8 / rules.speed) * 1000,
        );
        if (next < 0) next = rendered.length;
      }
      active = active.filter((comment) => {
        if (time >= comment.start + comment.duration) {
          comment.element.remove();
          return false;
        }
        position(comment, time);
        return true;
      });
      const maxLanes = Math.max(
        1,
        Math.floor((layer.clientHeight * rules.area) / (rules.fontSize * 1.5)),
      );
      while (
        !video.paused &&
        next < rendered.length &&
        rendered[next].progress / 1000 <= time
      ) {
        const row = rendered[next++],
          kind = [4, 5].includes(row.mode) ? row.mode : 1;
        if (
          active.length >= rules.density ||
          time >=
            row.progress / 1000 +
              ([4, 5].includes(row.mode) ? 4 : 8) / rules.speed
        )
          continue;
        let lane = -1;
        for (let i = 0; i < maxLanes; i++)
          if (
            !lanes.some(
              (l) => l.kind === kind && l.index === i && l.until > time,
            )
          ) {
            lane = i;
            break;
          }
        if (lane < 0) continue;
        const duration = ([4, 5].includes(row.mode) ? 4 : 8) / rules.speed,
          element = document.createElement("span");
        element.textContent = row.content;
        Object.assign(element.style, {
          position: "absolute",
          whiteSpace: "pre",
          font: `bold ${rules.fontSize}px Arial,sans-serif`,
          color: `#${row.color.toString(16).padStart(6, "0")}`,
          opacity: String(rules.opacity),
          textShadow: "1px 1px 2px #000",
          top: `${row.mode === 4 ? layer.clientHeight - (lane + 1) * rules.fontSize * 1.5 : lane * rules.fontSize * 1.5}px`,
        });
        layer.append(element);
        const comment = {
          element,
          width: element.getBoundingClientRect().width,
          start: row.progress / 1000,
          duration,
          mode: row.mode,
        };
        position(comment, time);
        active.push(comment);
        lanes.push({ kind, index: lane, until: time + duration });
      }
      for (let i = lanes.length - 1; i >= 0; i--)
        if (lanes[i].until <= time) lanes.splice(i, 1);
      lastTime = time;
      const index = Math.floor(time / 360) + 1;
      fetchSegment(index);
      if (time % 360 > 330) fetchSegment(index + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function mount(video) {
    videoNode = video;
    const token = generation;
    if (settings.modules.player) {
      playerControls(video);
      hideSections();
    }
    if (!settings.modules.tools && !settings.modules.player) return;
    const panel = LensVideoPanel.mount({
      video,
      settings,
      overlay: async (button, label) => {
        if (overlayActive) {
          stopVideo();
          mount(video);
          return;
        }
        button.disabled = true;
        label.textContent = "正在载入；失败时恢复原弹幕层…";
        try {
          await startOverlay(video, label, token);
          if (generation === token) button.textContent = "停用并恢复原弹幕";
        } catch (error) {
          if (generation === token) label.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      },
    });
    host = panel.host;
    disposers.push(panel.dispose);
  }

  function checkRoute(force = false) {
    if (stopped || !settings) return;
    const nextRoute = location.pathname + location.search,
      video = document.querySelector(
        ".bpx-player-video-wrap video,.bpx-player-video-area video",
      );
    if (!force && nextRoute === route && video === videoNode) return;
    stopVideo();
    route = nextRoute;
    if (LensMedia.videoFromUrl(location.href) && video) mount(video);
    filterBrowsing();
  }
  let timer = null;
  function start() {
    stopped = false;
    checkRoute(true);
    timer = setInterval(() => checkRoute(), 1000);
    if (settings.modules.browsing) {
      browsingObserver = new MutationObserver(() => {
        if (!browsingObserver.pending) {
          browsingObserver.pending = true;
          setTimeout(() => {
            browsingObserver && (browsingObserver.pending = false);
            if (!stopped) filterBrowsing();
          }, 150);
        }
      });
      browsingObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }
  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    browsingObserver?.disconnect();
    browsingObserver = null;
    stopVideo();
    restoreBrowsing();
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.op !== "seek") return;
    const parsed = LensMedia.videoFromUrl(location.href);
    if (!videoNode || !parsed || !Number.isFinite(message.time)) {
      respond({ ok: false });
      return;
    }
    const target = videoNode,
      token = generation;
    request("view", { id: parsed.id })
      .then((info) => {
        const selected = info.pages.find((p) => p.page === parsed.page);
        if (
          token !== generation ||
          target !== videoNode ||
          info.bvid !== message.bvid ||
          (message.cid && selected?.cid !== message.cid)
        ) {
          respond({ ok: false });
          return;
        }
        target.currentTime = Math.max(
          0,
          Math.min(target.duration || 86400, message.time),
        );
        respond({ ok: true });
      })
      .catch(() => respond({ ok: false }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[LensSettings.KEY]) return;
    try {
      settings = LensSettings.validate(changes[LensSettings.KEY].newValue);
      stop();
      start();
    } catch {}
  });
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", () => {
    if (stopped) start();
  });
  settings = await LensSettings.load();
  start();
})();
