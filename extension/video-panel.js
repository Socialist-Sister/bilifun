/* The requested video-page experience: a small launcher and an inline tools
 * drawer. Reuse the extension-origin tools page; never clone its privileged UI
 * into the website or accept website commands to download / change settings. */
(function (root) {
  "use strict";
  function mount({ video, settings, overlay }) {
    const host = document.createElement("div");
    host.id = "bili-lens-video-tools";
    Object.assign(host.style, {
      position: "fixed",
      bottom: "18px",
      [settings.ui.position]: "18px",
      zIndex: "2147483646",
      maxWidth: "calc(100vw - 32px)",
    });
    host.dataset.theme =
      settings.ui.theme === "auto"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : settings.ui.theme;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host{font:14px/1.5 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif;color:#203746;--paper:#fff;--ink:#203746;--line:#e0e7ef;--accent:#087fa9}
      :host([data-theme=dark]){--paper:#20323f;--ink:#e2eff5;--line:#415765;--accent:#7ed3e5}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button{font:inherit;color:var(--ink);cursor:pointer;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:7px 12px}
      button:focus-visible{outline:3px solid #e2a73d;outline-offset:3px}button:disabled{opacity:.5;cursor:default}
      .ball{width:48px;height:48px;border-radius:50%;padding:0;display:grid;place-items:center;box-shadow:0 4px 16px #009ed540;color:#fff;background:linear-gradient(145deg,#40c9ed,#009ed5);border:0;transition:transform 160ms ease,box-shadow 160ms ease}
      .ball{touch-action:none;user-select:none}.ball:hover{transform:translateY(-2px);box-shadow:0 6px 20px #009ed550}.ball.dragging{cursor:grabbing;transform:none;transition:none}.ball svg{width:26px;height:26px;pointer-events:none}.drawer{position:fixed;width:min(560px,calc(100vw - 88px));height:min(740px,calc(100dvh - 32px));min-height:0;background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 40px #20304726;display:flex;flex-direction:column;overflow:hidden;color:var(--ink)}
      .heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);flex:none}.heading strong{font-size:15px;display:flex;align-items:center;gap:10px}.heading svg{width:28px;height:28px;color:var(--accent)}.heading button{font-size:13px;border:0;color:var(--accent);background:transparent}
      .player-controls{order:2;padding:8px 16px;border-top:1px solid var(--line);flex:none}.player-controls button{font-size:12px;padding:4px 8px;background:transparent}.player-controls p{font-size:12px;margin:5px 0;overflow-wrap:anywhere}
      iframe{display:block;flex:1;width:100%;min-height:0;border:0;background:var(--paper)}
      .drawer.entering{animation:lens-drawer-in 220ms cubic-bezier(.2,.8,.2,1) both}.drawer.entering iframe{animation:lens-content-in 180ms ease-out 40ms both}
      @keyframes lens-drawer-in{from{opacity:0;transform:translateX(var(--slide-x,10px)) scale(.96)}to{opacity:1;transform:none}}
      @keyframes lens-content-in{from{opacity:0}to{opacity:1}}
      @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
      @media(max-width:480px){.heading{padding:10px 12px}}
    `;
    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "ball";
    ball.title = "点击打开视频工具，拖动调整位置";
    ball.setAttribute("aria-label", "展开视频工具");
    ball.setAttribute("aria-expanded", "false");
    ball.setAttribute("aria-controls", "lens-video-drawer");
    // Fixed extension-owned SVG, not HTML from the website or an API.
    ball.innerHTML =
      '<svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="3" y="6" width="22" height="17" rx="5" stroke="currentColor" stroke-width="2"/><path d="m10 2 3 4m5-4-3 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m12 11 6 4-6 4z" fill="currentColor"/></svg>';
    const drawer = document.createElement("section");
    drawer.id = "lens-video-drawer";
    drawer.className = "drawer";
    drawer.hidden = true;
    drawer.setAttribute("role", "region");
    drawer.setAttribute("aria-label", "视频工具面板");
    const heading = document.createElement("div"),
      title = document.createElement("strong"),
      close = document.createElement("button");
    heading.className = "heading";
    title.append(
      ball.querySelector("svg").cloneNode(true),
      document.createTextNode("BiliFun"),
    );
    close.type = "button";
    close.textContent = "收起";
    close.setAttribute("aria-label", "收起视频工具");
    heading.append(title, close);
    drawer.append(heading);
    if (settings.modules.player) {
      const controls = document.createElement("div"),
        button = document.createElement("button"),
        label = document.createElement("p");
      controls.className = "player-controls";
      button.type = "button";
      button.textContent = "启用过滤弹幕（实验）";
      label.setAttribute("role", "status");
      button.addEventListener("click", () => overlay(button, label));
      controls.append(button, label);
      drawer.append(controls);
    }
    let frame = null,
      disposed = false,
      scheduled = 0;
    const positionKey = "lensVideoBallPosition";
    let position = null,
      positionChanged = false,
      drag = null,
      suppressClick = false;
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const bounds = () => ({
      x: Math.max(0, innerWidth - 48 - 32),
      y: Math.max(0, innerHeight - 48 - 32),
      marginX: Math.min(16, Math.max(0, (innerWidth - 48) / 2)),
      marginY: Math.min(16, Math.max(0, (innerHeight - 48) / 2)),
    });
    const layout = () => {
      const b = bounds();
      const x = position
          ? b.marginX + position.x * b.x
          : settings.ui.position === "left"
            ? Math.min(18, b.marginX + b.x)
            : Math.max(b.marginX, innerWidth - 66),
        y = position
          ? b.marginY + position.y * b.y
          : Math.max(b.marginY, innerHeight - 66);
      Object.assign(host.style, {
        left: `${x}px`,
        top: `${y}px`,
        right: "auto",
        bottom: "auto",
      });
      if (drawer.hidden) return;
      const width = Math.max(0, Math.min(560, innerWidth - 88));
      const rightSpace = innerWidth - 16 - x - 48 - 8,
        leftSpace = x - 16 - 8;
      const openRight =
        rightSpace >= width || (leftSpace < width && rightSpace >= leftSpace);
      // Keep the launcher beside the drawer. On narrow viewports, shift the
      // open pair just enough to fit; collapse restores the saved ball position.
      const ballX = openRight
        ? clamp(x, 16, Math.max(16, innerWidth - 16 - 48 - 8 - width))
        : clamp(x, 16 + width + 8, Math.max(16 + width + 8, innerWidth - 64));
      host.style.left = `${ballX}px`;
      drawer.style.width = `${width}px`;
      const height = drawer.offsetHeight;
      const top = clamp(y, 16, Math.max(16, innerHeight - height - 16));
      drawer.style.setProperty("--slide-x", openRight ? "-10px" : "10px");
      Object.assign(drawer.style, {
        left: `${openRight ? ballX + 56 : ballX - width - 8}px`,
        top: `${top}px`,
        transformOrigin: `${openRight ? "left" : "right"} ${clamp(y - top + 24, 0, height)}px`,
      });
    };
    const endDrag = (cancelled = false) => {
      if (!drag) return;
      const ended = drag;
      drag = null;
      ball.classList.remove("dragging");
      if (ball.hasPointerCapture(ended.id))
        ball.releasePointerCapture(ended.id);
      if (!ended.moved) return;
      suppressClick = true;
      if (cancelled) position = ended.original;
      else
        chrome.storage.local.set({ [positionKey]: position }).catch(() => {});
      layout();
    };
    ball.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      suppressClick = false;
      const box = host.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: box.left,
        y: box.top,
        original: position,
        moved: false,
      };
      ball.setPointerCapture(event.pointerId);
    });
    ball.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.startX,
        dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      positionChanged = true;
      ball.classList.add("dragging");
      const b = bounds();
      position = {
        x: b.x ? clamp((drag.x + dx - b.marginX) / b.x, 0, 1) : 0,
        y: b.y ? clamp((drag.y + dy - b.marginY) / b.y, 0, 1) : 0,
      };
      event.preventDefault();
      layout();
    });
    ball.addEventListener("pointerup", (event) => {
      if (drag?.id === event.pointerId) endDrag();
    });
    ball.addEventListener("pointercancel", (event) => {
      if (drag?.id === event.pointerId) endDrag(true);
    });
    ball.addEventListener("lostpointercapture", () => endDrag(true));
    const collapse = (focus = true) => {
      drawer.hidden = true;
      drawer.classList.remove("entering");
      ball.setAttribute("aria-expanded", "false");
      ball.setAttribute("aria-label", "展开视频工具");
      layout();
      if (focus && !host.hidden) ball.focus();
    };
    const fullscreen = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement)
        return true;
      const player = video.closest(".bpx-player-container,.bilibili-player");
      if (
        document.querySelector(
          ".bpx-state-web,.bpx-state-full,.bilibili-player-video-web-fullscreen",
        ) ||
        document.body?.classList.contains("player-mode-webfullscreen")
      )
        return true;
      if (!player) return false;
      const box = player.getBoundingClientRect();
      return (
        box.width >= innerWidth - 4 &&
        box.height >= innerHeight - 4 &&
        Math.abs(box.top) <= 4 &&
        Math.abs(box.left) <= 4
      );
    };
    const refresh = () => {
      scheduled = 0;
      if (disposed) return;
      const hidden = fullscreen();
      if (hidden) collapse(false);
      host.hidden = hidden;
      // Inline important overrides the website's generic [hidden] display rules.
      if (hidden) host.style.setProperty("display", "none", "important");
      else host.style.removeProperty("display");
      if (hidden) endDrag(true);
      layout();
    };
    const schedule = () => {
      if (!scheduled && !disposed) scheduled = requestAnimationFrame(refresh);
    };
    const toggle = () => {
      refresh();
      if (host.hidden) return;
      if (!drawer.hidden) {
        collapse();
        return;
      }
      if (!frame && settings.modules.tools) {
        const parsed = LensMedia.videoFromUrl(location.href);
        if (!parsed) return;
        frame = document.createElement("iframe");
        frame.title = "当前视频下载、弹幕与字幕";
        frame.src = chrome.runtime.getURL(
          `tools.html?embed=1&id=${encodeURIComponent(parsed.id)}&p=${parsed.page}`,
        );
        drawer.append(frame);
      }
      drawer.hidden = false;
      layout();
      drawer.classList.add("entering");
      ball.setAttribute("aria-expanded", "true");
      ball.setAttribute("aria-label", "收起视频工具");
      close.focus();
    };
    ball.addEventListener("click", (event) => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      toggle();
    });
    close.addEventListener("click", () => collapse());
    const keyboard = (event) => {
      if (event.key === "Escape" && drag) endDrag(true);
      if (event.key === "Escape" && !drawer.hidden) {
        collapse();
        event.stopPropagation();
      }
    };
    shadow.addEventListener("keydown", keyboard);
    const message = (event) => {
      const expected = new URL(chrome.runtime.getURL("tools.html")).origin;
      if (
        frame &&
        event.source === frame.contentWindow &&
        event.origin === expected &&
        event.data?.type === "lens-tools-collapse"
      )
        collapse();
    };
    window.addEventListener("message", message);
    document.addEventListener("fullscreenchange", refresh);
    document.addEventListener("webkitfullscreenchange", refresh);
    window.addEventListener("resize", schedule);
    // Observe only player ancestors and page state attributes, not every card
    // or comment mutation. Polling covers player replacements and CSS-only modes.
    const observer = new MutationObserver(schedule);
    for (
      let element =
        video.closest(".bpx-player-container,.bilibili-player") ||
        video.parentElement;
      element;
      element = element.parentElement
    )
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["class", "style", "data-screen"],
      });
    const timer = setInterval(refresh, 1000);
    shadow.append(style, drawer, ball);
    document.documentElement.append(host);
    refresh();
    chrome.storage.local
      .get(positionKey)
      .then((saved) => {
        const value = saved[positionKey];
        if (
          disposed ||
          positionChanged ||
          drag ||
          !value ||
          !Number.isFinite(value.x) ||
          !Number.isFinite(value.y) ||
          value.x < 0 ||
          value.x > 1 ||
          value.y < 0 ||
          value.y > 1
        )
          return;
        position = { x: value.x, y: value.y };
        layout();
      })
      .catch(() => {});
    return {
      host,
      dispose() {
        disposed = true;
        endDrag(true);
        clearInterval(timer);
        cancelAnimationFrame(scheduled);
        observer.disconnect();
        document.removeEventListener("fullscreenchange", refresh);
        document.removeEventListener("webkitfullscreenchange", refresh);
        window.removeEventListener("resize", schedule);
        window.removeEventListener("message", message);
        host.remove();
      },
    };
  }
  root.LensVideoPanel = Object.freeze({ mount });
})(globalThis);
