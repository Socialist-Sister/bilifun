/* Presentation only. The parent may request no privileged action. */
"use strict";
if (new URL(location.href).searchParams.get("embed") === "1") {
  document.documentElement.dataset.embedded = "true";
  document.addEventListener("DOMContentLoaded", () => {
    const get = (id) => document.getElementById(id);
    const context = get("video-context"),
      summary = document.createElement("div"),
      info = document.createElement("div"),
      controls = document.createElement("div"),
      advanced = document.createElement("details"),
      caption = document.createElement("summary");
    summary.className = "panel-summary";
    info.className = "panel-video-info";
    controls.className = "panel-read-actions";
    const part = get("page-select").closest("label");
    part.className = "panel-part-picker";
    get("auto-state").hidden = false;
    info.append(get("video-title"));
    // Automatic reading may already have reached the permission prompt before
    // DOMContentLoaded; presentation must not overwrite that action label.
    if (get("load").textContent !== "授权并读取")
      get("load").textContent = "刷新信息";
    controls.append(get("load"), get("cancel-read"));
    summary.append(get("panel-cover"), info, controls, part, get("auto-state"));
    caption.textContent = "视频链接、封面与信息导出";
    advanced.append(
      caption,
      get("video-input").closest("label"),
      get("metadata"),
      get("cover"),
    );
    context.replaceChildren(summary, get("status"), advanced);

    // Reuse the same simple/advanced structure as the standalone tools page.
    // Refresh is already available beside the video summary in the drawer.
    get("media-advanced").insertBefore(
      get("get-streams"),
      get("media-advanced").querySelector("summary").nextSibling,
    );
    document.querySelector('[data-tab="media"]').textContent = "视频 / 音频";
    document.querySelector('[data-tab="subtitles"]').textContent = "字幕";
    document.querySelector('[data-tab="queue"]').textContent = "任务";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && window.parent !== window) {
      event.preventDefault();
      window.parent.postMessage(
        { type: "lens-tools-collapse" },
        "https://www.bilibili.com",
      );
    }
  });
}
