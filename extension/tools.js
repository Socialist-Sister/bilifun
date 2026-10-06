"use strict";
const $ = (id) => document.getElementById(id),
  CDN = [
    "https://*.hdslb.com/*",
    "https://*.bilivideo.com/*",
    "https://*.bilivideo.cn/*",
    "https://*.bilivideo.net/*",
    "https://*.biliapi.net/*",
  ];
let settings,
  video,
  streams,
  subtitleTracks = [],
  subtitleData = null,
  rows = [],
  filtered = { kept: [], rejected: [] },
  coverage = {},
  generation = 0,
  partVersion = 0,
  currentToken = "",
  searchCancelled = false,
  tasks = [],
  filterGeneration = 0;
const speeds = new Map();
let resourceRead = null,
  readSequence = 0,
  autoSequence = 0;
const embedded = document.documentElement.dataset.embedded === "true";
function renderTaskName(element, title, part, format = "") {
  element.className = "task-name";
  const heading = document.createElement("div"),
    meta = document.createElement("div");
  heading.className = "task-title";
  heading.textContent = title || "未命名视频";
  heading.title = heading.textContent;
  meta.className = "task-meta";
  const normalize = (value) => String(value || "").replace(/\s+/g, "");
  if (part && normalize(part) !== normalize(title)) meta.textContent = part;
  if (format) {
    const badge = document.createElement("span");
    badge.className = "task-format";
    badge.textContent = format;
    meta.append(badge);
  }
  element.append(heading);
  if (meta.textContent) element.append(meta);
}
function renderTaskState(element, state, label, error) {
  element.className = "task-state";
  const badge = document.createElement("span");
  badge.className = "task-status";
  badge.dataset.state = state;
  badge.textContent = label;
  element.append(badge);
  if (error) {
    const message = document.createElement("p");
    message.className = "task-error";
    message.textContent = error;
    element.append(message);
  }
}
function notice(text, error = false) {
  $("status").textContent = text;
  $("status").className = `status${error ? " error" : ""}`;
}
async function request(op, params = {}, options) {
  if (options) return LensRpc.request({ op, ...params }, options);
  const response = await chrome.runtime.sendMessage({ op, ...params });
  if (!response?.ok)
    throw new Error(response?.error || "后台未响应，请重载扩展后刷新工具页");
  return response.result;
}
function bind(name, action) {
  $(name).addEventListener("click", async () => {
    const button = $(name);
    button.disabled = true;
    try {
      if (!settings) throw new Error("设置正在加载，请稍候");
      await action();
    } catch (error) {
      if (error.name !== "AbortError") notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
function page() {
  if (!video) throw new Error("请先读取视频信息");
  const result = video.pages.find(
    (p) => p.cid === Number($("page-select").value),
  );
  if (!result) throw new Error("请选择有效分 P");
  return result;
}
function option(value, text) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = text;
  return el;
}
function saveFile(text, name, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime }),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function apiPermission() {
  if (
    !(await chrome.permissions.contains({
      origins: ["https://api.bilibili.com/*"],
    })) &&
    !(await chrome.permissions.request({
      origins: ["https://api.bilibili.com/*"],
    }))
  )
    throw new Error("接口访问未授权，搜索筛选仍可使用");
}
async function downloadPermission() {
  const permission = {
    permissions: ["downloads", "declarativeNetRequestWithHostAccess"],
    origins: ["https://api.bilibili.com/*", ...CDN],
  };
  if (
    !(await chrome.permissions.contains(permission)) &&
    !(await chrome.permissions.request(permission))
  )
    throw new Error("下载权限未授权");
}
function resetPart() {
  resourceRead?.controller.abort();
  generation++;
  partVersion++;
  filterGeneration++;
  coverage = {};
  if (currentToken)
    request("cancelRequest", { token: currentToken }).catch(() => {});
  streams = null;
  $("media-estimate").textContent = "读取资源后显示所选轨道的估算大小。";
  rows = [];
  filtered = { kept: [], rejected: [] };
  subtitleData = null;
  subtitleTracks = [];
  $("video-track").replaceChildren(option("", "未读取"));
  $("audio-track").replaceChildren(option("", "未读取"));
  $("direct-tracks").replaceChildren();
  $("subtitle-track").replaceChildren(option("", "未读取"));
  $("subtitle-results").replaceChildren();
  $("danmaku-list").replaceChildren();
  $("danmaku-coverage").textContent =
    "只获取当前可访问的数据，不代表全部历史弹幕。";
  $("filter-count").textContent = "尚未获取弹幕";
}
function startRead(kind) {
  resourceRead?.controller.abort();
  const read = {
    kind,
    token: `resource-${Date.now()}-${++readSequence}`,
    controller: new AbortController(),
  };
  resourceRead = read;
  $("cancel-read").disabled = false;
  return read;
}
function finishRead(read) {
  if (resourceRead !== read) return;
  resourceRead = null;
  $("cancel-read").disabled = true;
}
$("cancel-read").addEventListener("click", () => {
  const kind = resourceRead?.kind || "资源";
  stopAutomatic();
  notice(`已停止读取${kind}，可重新尝试。`);
});
$("video-input").addEventListener("input", () => {
  stopAutomatic();
  notice("输入已改变，已停止原来的读取。请重新点击读取视频信息。");
});
window.addEventListener("pagehide", () => {
  stopAutomatic();
  generation++;
  partVersion++;
  filterGeneration++;
  searchCancelled = true;
  if (currentToken)
    request("cancelRequest", { token: currentToken }).catch(() => {});
});
function automaticState(text, state = "idle") {
  if (!embedded) return;
  $("auto-state").textContent = text;
  $("auto-state").dataset.state = state;
  $("video-context").classList.toggle("is-reading", state === "loading");
}
function stopAutomatic() {
  const running =
    resourceRead || (embedded && $("auto-state").dataset.state === "loading");
  autoSequence++;
  generation++;
  resourceRead?.controller.abort();
  if (running) automaticState("读取已暂停");
}
async function readAutomatic(authorize = false, partOnly = false) {
  const run = ++autoSequence;
  resourceRead?.controller.abort();
  const permission = { origins: ["https://api.bilibili.com/*"] };
  automaticState("检查授权", "loading");
  try {
    if (!(await chrome.permissions.contains(permission))) {
      if (!authorize || !(await chrome.permissions.request(permission))) {
        if (run !== autoSequence) return;
        automaticState("等待授权");
        $("load").textContent = "授权并读取";
        notice(
          "首次使用需授权访问 B 站接口，点击“授权并读取”后自动加载视频、轨道和字幕列表。",
        );
        return;
      }
    }
    if (run !== autoSequence) return;
    $("load").textContent = "刷新信息";
    if (!partOnly) {
      automaticState("1 / 3 · 视频信息", "loading");
      await readVideo();
    }
    if (run !== autoSequence) return;
    const context = generation,
      failures = [];
    for (const [label, action] of [
      ["2 / 3 · 媒体轨道", readStreams],
      ["3 / 3 · 字幕列表", readSubtitles],
    ]) {
      if (run !== autoSequence || context !== generation) return;
      automaticState(label, "loading");
      try {
        await action();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        failures.push(error.message);
      }
    }
    if (run !== autoSequence || context !== generation) return;
    automaticState(
      failures.length ? "部分读取失败" : "已自动读取",
      failures.length ? "error" : "ready",
    );
    notice(
      failures.length
        ? `视频信息已保留；${failures.join("；")}。点击刷新信息可重试。`
        : `已就绪 · 视频 ${streams?.video.length || 0} 条 · 音频 ${streams?.audio.length || 0} 条 · 字幕 ${subtitleTracks.length} 条。${resourceAvailability()}选择资源后点击下载。`,
      !!failures.length,
    );
  } catch (error) {
    if (run !== autoSequence) return;
    automaticState(
      error.name === "AbortError" ? "读取已暂停" : "读取失败，可重试",
      error.name === "AbortError" ? "idle" : "error",
    );
    if (error.name !== "AbortError") notice(error.message, true);
  }
}
function currentRules() {
  const base = video
    ? LensSettings.forVideo(settings, video.bvid, video.owner.mid)
    : settings.danmaku;
  return {
    ...base,
    exclusions: $("danmaku-exclusions").value,
    whitelist: $("danmaku-whitelist").value,
    regex: $("danmaku-regex").value.split(/\n/).filter(Boolean),
  };
}
function fillRules() {
  const rules = video
    ? LensSettings.forVideo(settings, video.bvid, video.owner.mid)
    : settings.danmaku;
  $("danmaku-exclusions").value = rules.exclusions;
  $("danmaku-whitelist").value = rules.whitelist;
  $("danmaku-regex").value = rules.regex.join("\n");
}
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => {
    for (const tab of document.querySelectorAll("[data-tab]")) {
      const active = tab === button;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.dataset.tab).hidden = !active;
    }
    if (button.dataset.tab === "queue")
      refreshTasks().catch((error) => notice(error.message, true));
  });
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  const tabs = [...document.querySelectorAll("[data-tab]")].filter(
    (tab) => tab.getClientRects().length,
  );
  const index = tabs.indexOf(event.target);
  if (
    index < 0 ||
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  )
    return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
          tabs.length;
  tabs[next].click();
  tabs[next].focus();
});
async function readVideo() {
  const value = $("video-input").value.trim();
  let id = value,
    part = 1;
  if (value.startsWith("http")) {
    const parsed = LensMedia.videoFromUrl(value);
    if (!parsed) throw new Error("仅支持普通投稿视频链接");
    id = parsed.id;
    part = parsed.page;
  }
  if (!/^(BV\w{8,22}|av\d{1,16})$/.test(id))
    throw new Error("请输入有效的普通视频链接、BV 号或 av 号");
  const route = new URL(location.href);
  if (video?.bvid === id) part = page().page;
  if (
    !video &&
    route.searchParams.get("id") === id &&
    /^\d+$/.test(route.searchParams.get("p") || "")
  )
    part = Number(route.searchParams.get("p"));
  notice("正在检查接口权限；如有浏览器授权弹窗，请先完成授权。");
  const permissionGeneration = generation;
  await apiPermission();
  if (permissionGeneration !== generation)
    throw new DOMException("旧读取已取消", "AbortError");
  resetPart();
  video = null;
  $("video-title").textContent = "";
  $("page-select").replaceChildren(option("", "正在读取"));
  $("page-select").disabled = true;
  $("metadata").disabled = true;
  $("cover").disabled = true;
  $("batch-pages").replaceChildren();
  const token = generation,
    read = startRead("视频信息");
  notice("正在读取视频信息…（最多等待 25 秒，可停止）");
  let result;
  try {
    result = await request(
      "view",
      { id, token: read.token },
      { signal: read.controller.signal },
    );
  } catch (error) {
    if (resourceRead !== read || token !== generation)
      throw new DOMException("旧读取已取消", "AbortError");
    $("page-select").replaceChildren(option("", "未读取，请重试"));
    throw error;
  } finally {
    finishRead(read);
  }
  if (token !== generation) return;
  video = result;
  $("page-select").replaceChildren(
    ...video.pages.map((p) => option(String(p.cid), `P${p.page} · ${p.part}`)),
  );
  $("page-select").disabled = false;
  $("page-select").value = String(
    (video.pages.find((p) => p.page === part) || video.pages[0]).cid,
  );
  const videoHeading = document.createElement("span"),
    videoByline = document.createElement("span");
  videoHeading.className = "video-heading";
  videoHeading.textContent = video.title;
  videoHeading.title = video.title;
  videoByline.className = "video-byline";
  videoByline.textContent = `${video.owner.name} · ${video.pages.length} 个分 P`;
  videoByline.title = videoByline.textContent;
  $("video-title").replaceChildren(videoHeading, videoByline);
  $("metadata").disabled = false;
  $("cover").disabled = false;
  $("batch-pages").replaceChildren(
    ...video.pages.map((p) => {
      const label = document.createElement("label"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.value = p.cid;
      label.append(box, document.createTextNode(`P${p.page} · ${p.part}`));
      return label;
    }),
  );
  fillRules();
  renderBookmarks();
  if (embedded) {
    const cover = $("panel-cover");
    try {
      cover.src = LensMedia.safeUrl(
        String(video.pic || "").replace(/^http:/, "https:"),
        true,
      );
      cover.hidden = false;
    } catch {
      cover.hidden = true;
    }
  }
  notice("视频信息已读取。请选择工具；不会自动开始下载。");
}
bind("load", () => (embedded ? readAutomatic(true) : readVideo()));
$("page-select").addEventListener("change", () => {
  stopAutomatic();
  resetPart();
  if (embedded)
    readAutomatic(false, true).catch((error) => notice(error.message, true));
  else notice("已切换分 P；媒体、弹幕和字幕需要重新读取。");
});
bind("metadata", () =>
  saveFile(
    JSON.stringify(video, null, 2),
    `${LensMedia.cleanName(video.title)}.json`,
    "application/json",
  ),
);
bind("cover", async () => {
  if (!video) throw new Error("请先读取视频");
  await downloadPermission();
  const url = LensMedia.safeUrl(video.pic, true);
  const extension = /\.(png|webp|jpe?g)(?:\?|$)/i.exec(url)?.[1] || "jpg";
  await chrome.downloads.download({
    url,
    filename: `${LensMedia.cleanName(video.title)}-cover.${extension}`,
    saveAs: true,
  });
  notice("封面已交给浏览器保存。");
});
async function readStreams() {
  const selected = page(),
    token = generation;
  await apiPermission();
  if (token !== generation) return;
  const read = startRead("媒体轨道");
  streams = null;
  $("video-track").replaceChildren(option("", "正在读取"));
  $("audio-track").replaceChildren(option("", "正在读取"));
  $("direct-tracks").replaceChildren();
  notice("正在读取可用媒体轨道…（最多等待 25 秒，可停止）");
  let result;
  try {
    result = await request(
      "streams",
      {
        bvid: video.bvid,
        cid: selected.cid,
        token: read.token,
        refresh: true,
      },
      { signal: read.controller.signal },
    );
  } catch (error) {
    if (resourceRead !== read || token !== generation)
      throw new DOMException("旧读取已取消", "AbortError");
    $("video-track").replaceChildren(option("", "未读取"));
    $("audio-track").replaceChildren(option("", "未读取"));
    throw error;
  } finally {
    finishRead(read);
  }
  if (token !== generation) return;
  streams = result;
  $("video-track").replaceChildren(
    option("", "不下载视频"),
    ...streams.video.map((t) => option(t.key, t.label)),
    ...(streams.unavailableQualities || []).map((quality) => {
      const unavailable = option("", `${quality.label}（接口未返回链接）`);
      unavailable.disabled = true;
      return unavailable;
    }),
  );
  $("audio-track").replaceChildren(
    option(
      "",
      streams.video.length && !streams.audio.length
        ? "接口未返回音轨链接"
        : "不下载音频",
    ),
    ...streams.audio.map((t) => option(t.key, t.label)),
  );
  if (streams.video.length)
    $("video-track").value = (
      streams.video.find((t) => /avc1/i.test(t.codec || t.key)) ||
      streams.video[0]
    ).key;
  if (streams.audio.length)
    $("audio-track").value = (
      streams.audio.find((t) => /mp4a/i.test(t.codec || t.key)) ||
      streams.audio[0]
    ).key;
  updateEstimate();
  $("direct-tracks").replaceChildren(
    ...streams.direct.map((track) => {
      const button = document.createElement("button");
      button.textContent = `下载 ${track.label}`;
      button.addEventListener("click", () =>
        enqueue([track.key]).catch((error) => notice(error.message, true)),
      );
      return button;
    }),
  );
  notice(
    `可用视频轨道 ${streams.video.length} 条，音频 ${streams.audio.length} 条，直连文件 ${streams.direct.length} 个。${resourceAvailability()}DASH 分轨可下载并合并成品，或分别保存轨道。`,
  );
}
bind("get-streams", () => {
  stopAutomatic();
  return readStreams();
});
async function enqueue(keys, selected = page()) {
  if (!streams && !keys.some((k) => k.startsWith("direct:")))
    throw new Error("请先读取可用轨道");
  keys = keys.filter(Boolean);
  if (!keys.length) throw new Error("没有选择轨道");
  await downloadPermission();
  await request("enqueue", { bvid: video.bvid, cid: selected.cid, keys });
  notice("任务已加入下载中心；分轨保存不等于音视频合并完成。");
  await refreshTasks();
}
function resourceAvailability() {
  if (!streams) return "";
  let text = streams.unavailableQualities?.length
    ? `另有 ${streams.unavailableQualities.length} 种清晰度未返回下载链接；可确认登录和会员权限后刷新。`
    : "";
  if (streams.video.length && !streams.audio.length)
    text += "未取得独立音轨，暂不能合并有声 MP4；请刷新重试。";
  return text;
}
function updateEstimate() {
  if (!streams) return;
  const tracks = [...streams.video, ...streams.audio].filter((t) =>
      [$("video-track").value, $("audio-track").value].includes(t.key),
    ),
    bytes = LensMedia.estimatedBytes(
      tracks,
      streams.duration || page().duration,
    );
  $("media-estimate").textContent =
    (bytes
      ? `预计下载 ${(bytes / 1048576).toFixed(1)} MB；合并还需成品文件空间。`
      : "接口未提供足够信息，暂时无法估计文件大小。") +
    " MP4 在插件内无损重封装；临时磁盘约需总大小的 2.2 倍。" +
    resourceAvailability();
}
$("video-track").addEventListener("change", updateEstimate);
$("audio-track").addEventListener("change", updateEstimate);
bind("download-complete", async () => {
  const part = page();
  if (!streams) throw new Error("请先读取并选择视频轨道和音轨");
  if (!streams.video.length && !streams.audio.length) {
    if (streams.direct.length !== 1)
      throw new Error("此视频包含多个直连片段，请逐段下载；暂不自动拼接");
    await enqueue([streams.direct[0].key], part);
    return;
  }
  const permission = {
    permissions: ["downloads", "declarativeNetRequestWithHostAccess"],
    origins: ["https://api.bilibili.com/*", ...CDN],
  };
  if (
    !(await chrome.permissions.contains(permission)) &&
    !(await chrome.permissions.request(permission))
  )
    throw new Error("成品下载权限未授权");
  const job = await request("enqueueVideo", {
    bvid: video.bvid,
    cid: part.cid,
    videoKey: $("video-track").value,
    audioKey: $("audio-track").value,
    container: $("complete-container").value,
  });
  notice(
    "已创建插件内下载任务，可在下载任务页查看进度或取消；关闭面板后继续。",
  );
  document.querySelector('[data-tab="queue"]').click();
  await refreshTasks();
});
bind("download-both", () =>
  enqueue([$("video-track").value, $("audio-track").value]),
);
bind("download-video", () => enqueue([$("video-track").value]));
bind("download-audio", () => downloadAudio("m4a"));
bind("batch-download", async () => {
  if (!streams) throw new Error("请先读取并选择媒体轨道");
  const token = generation,
    bvid = video.bvid,
    videoKey = $("video-track").value,
    audioKey = $("audio-track").value;
  const selected = [
    ...document.querySelectorAll("#batch-pages input:checked"),
  ].map((box) => video.pages.find((p) => p.cid === Number(box.value)));
  if (!selected.length || selected.length > 30 || selected.some((p) => !p))
    throw new Error("请选择 1–30 个分 P");
  if (!videoKey || !audioKey)
    throw new Error("批量 MP4 下载需要选择视频轨道和音轨");
  await downloadPermission();
  let added = 0;
  try {
    for (const p of selected) {
      if (token !== generation)
        throw new Error("视频或分 P 已切换，停止添加后续任务");
      try {
        await request("enqueueVideo", {
          bvid,
          cid: p.cid,
          videoKey,
          audioKey,
          container: "mp4",
        });
      } catch (error) {
        throw new Error(`P${p.page}：${error.message}`);
      }
      added++;
      notice(`已加入 ${added} / ${selected.length} 个分 P 的 MP4 任务。`);
    }
  } catch (error) {
    await refreshTasks();
    throw new Error(
      `${error.message}；已加入 ${added} 个任务，可在下载任务页查看，其余未加入。`,
    );
  }
  notice(`已加入 ${added} 个分 P；每个分 P 保存为一个带声音的 MP4。`);
  document.querySelector('[data-tab="queue"]').click();
  await refreshTasks();
});
async function applyFilter() {
  const token = ++filterGeneration,
    snapshot = rows;
  const worker = new Worker(chrome.runtime.getURL("filter-worker.js"));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("弹幕过滤超过 3 秒，已停止；请简化正则或规则"));
    }, 3000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      event.data.ok
        ? resolve(event.data.result)
        : reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error("弹幕过滤工作线程失败"));
    };
    worker.postMessage({ rows: snapshot, rules: currentRules() });
  });
  if (token !== filterGeneration || snapshot !== rows) return;
  filtered = result;
  $("filter-count").textContent =
    `获取 ${rows.length} 条 · 保留 ${filtered.kept.length} 条 · 过滤 ${filtered.rejected.length} 条`;
  renderDanmaku();
}
function renderDanmaku() {
  const query = BiliSearchLens.normalize($("list-query").value),
    list = ($("show-rejected").checked ? filtered.rejected : filtered.kept)
      .filter((row) => BiliSearchLens.normalize(row.content).includes(query))
      .filter(
        (row) =>
          !$("list-mode").value || row.mode === Number($("list-mode").value),
      )
      .slice(0, 500);
  $("danmaku-list").replaceChildren(
    ...list.map((row) => {
      const tr = document.createElement("tr"),
        time = document.createElement("td"),
        content = document.createElement("td"),
        reason = document.createElement("td"),
        button = document.createElement("button");
      button.textContent = LensDanmaku.assTime(row.progress / 1000);
      button.addEventListener("click", () =>
        seek(row.progress / 1000).catch((error) => notice(error.message, true)),
      );
      time.append(button);
      content.textContent = row.content;
      reason.textContent = row.reason || "保留";
      tr.append(time, content, reason);
      return tr;
    }),
  );
}
async function seek(time, targetCid) {
  if (!video) throw new Error("本地导入弹幕没有对应视频；请先读取视频");
  const count = await request("seek", {
    bvid: video.bvid,
    cid: targetCid || page().cid,
    time,
  });
  notice(
    count
      ? "已定位到打开的对应分 P；不会自动开始播放。"
      : "没有打开对应分 P，请先在 B 站打开该分 P。",
  );
}
bind("get-danmaku", async () => {
  const selected = page(),
    token = ++generation,
    version = partVersion,
    received = [];
  let receivedBytes = 0;
  await apiPermission();
  rows = [];
  filtered = { kept: [], rejected: [] };
  const report = {
    bvid: video.bvid,
    cid: selected.cid,
    fetchedAt: new Date().toISOString(),
    requestedSegments: Math.max(1, Math.ceil(selected.duration / 360)),
    loadedSegments: [],
    failedSegments: [],
  };
  if (report.requestedSegments > 200)
    throw new Error("视频超过当前 200 分段上限，请使用更短分 P");
  $("cancel-danmaku").disabled = false;
  for (let index = 1; index <= report.requestedSegments; index++) {
    if (token !== generation) break;
    currentToken = `danmaku:${token}:${index}`;
    notice(`正在获取弹幕分段 ${index}/${report.requestedSegments}…`);
    try {
      const part = await request("segment", {
        cid: selected.cid,
        index,
        token: currentToken,
      });
      if (token !== generation) break;
      if (received.length + part.length > 200000)
        throw new Error("弹幕超过 20 万条上限");
      const bytes = new TextEncoder().encode(JSON.stringify(part)).length;
      if (receivedBytes + bytes > 30 * 1024 * 1024)
        throw new Error("弹幕超过 30 MB 上限，请分批获取");
      receivedBytes += bytes;
      received.push(...part);
      report.loadedSegments.push(index);
    } catch (error) {
      if (token !== generation) break;
      report.failedSegments.push(index);
      notice(`分段 ${index} 获取失败：${error.message}`, true);
      if (/风控|验证|超过/.test(error.message)) break;
    }
    if (index < report.requestedSegments && token === generation)
      await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (version !== partVersion) return;
  currentToken = "";
  $("cancel-danmaku").disabled = true;
  coverage = report;
  coverage.cancelled = token !== generation;
  rows = LensDanmaku.dedupe(received);
  $("danmaku-coverage").textContent =
    `已获取 ${coverage.loadedSegments.length}/${coverage.requestedSegments} 个分段${coverage.cancelled ? " · 已取消" : ""}，失败 ${coverage.failedSegments.length} 个；不代表全部历史弹幕。`;
  await applyFilter();
  notice("弹幕获取结束；请核对获取范围后导出。");
});
bind("cancel-danmaku", async () => {
  generation++;
  if (currentToken) await request("cancelRequest", { token: currentToken });
  notice("已取消后续弹幕请求。");
});
bind("apply-filter", applyFilter);
bind("save-rules", async () => {
  settings.danmaku = currentRules();
  settings = await LensSettings.save(settings);
  notice("全局弹幕规则已保存。");
});
bind("save-video-rules", async () => {
  page();
  settings.profiles = settings.profiles.filter((p) => p.scope !== video.bvid);
  settings.profiles.push({ scope: video.bvid, rules: currentRules() });
  settings = await LensSettings.save(settings);
  notice("本视频专用规则已保存。");
});
$("list-query").addEventListener("input", renderDanmaku);
$("list-mode").addEventListener("change", renderDanmaku);
$("show-rejected").addEventListener("change", renderDanmaku);
async function importDanmaku(file) {
  try {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) throw new Error("文件超过 30 MB");
    const text = await file.text();
    generation++;
    partVersion++;
    filterGeneration++;
    if (currentToken) await request("cancelRequest", { token: currentToken });
    currentToken = "";
    $("cancel-danmaku").disabled = true;
    rows = file.name.toLowerCase().endsWith(".xml")
      ? LensDanmaku.parseXml(text)
      : file.name.toLowerCase().endsWith(".ass")
        ? LensDanmaku.parseAss(text)
        : LensDanmaku.validateRows(
            (() => {
              const parsed = JSON.parse(text);
              return Array.isArray(parsed) ? parsed : parsed.rows;
            })(),
          );
    rows = LensDanmaku.dedupe(rows);
    coverage = { source: "local", file: file.name };
    if (file.name.toLowerCase().endsWith(".ass"))
      coverage.notice =
        "ASS 只导入普通对话文字和起始时间，不保留绘图、样式及完整运动信息";
    $("danmaku-coverage").textContent =
      `本地导入：${file.name} · ${rows.length} 条`;
    await applyFilter();
    notice("本地弹幕已导入。");
  } catch (error) {
    notice(error.message, true);
  }
}
$("import-danmaku").addEventListener("change", (event) =>
  importDanmaku(event.target.files[0]),
);
$("danmaku").addEventListener("dragover", (event) => {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault();
});
$("danmaku").addEventListener("drop", (event) => {
  if (event.dataTransfer.files.length) {
    event.preventDefault();
    importDanmaku(event.dataTransfer.files[0]);
  }
});
bind("export-danmaku", async () => {
  if (!rows.length) throw new Error("没有可导出的弹幕");
  if ($("export-source").value !== "raw") await applyFilter();
  const selected = $("export-source").value === "raw" ? rows : filtered.kept,
    format = $("danmaku-format").value,
    prefix = video
      ? `${LensMedia.cleanName(video.title)}-P${page().page}`
      : "local-danmaku";
  let text;
  if (format === "json")
    text = JSON.stringify(
      {
        coverage,
        filtered: $("export-source").value !== "raw",
        rows: selected,
      },
      null,
      2,
    );
  else if (format === "xml") text = LensDanmaku.xml(selected, coverage.cid);
  else {
    const output = LensDanmaku.ass(selected, currentRules());
    text = output.text;
    notice(
      `ASS 导出：高级类型 ${output.unsupported} 条未渲染，轨道拥挤 ${output.dropped} 条省略；原始数据可另存 JSON/XML。`,
    );
  }
  saveFile(text, `${prefix}-${$("export-source").value}.${format}`);
});
async function readSubtitles() {
  const selected = page(),
    token = generation;
  await apiPermission();
  if (token !== generation) return;
  const read = startRead("字幕列表");
  notice("正在读取字幕列表…（最多等待 25 秒，可停止）");
  let info;
  try {
    info = await request(
      "playerInfo",
      { bvid: video.bvid, cid: selected.cid, token: read.token },
      { signal: read.controller.signal },
    );
  } finally {
    finishRead(read);
  }
  if (token !== generation) return;
  subtitleTracks = (info.subtitle?.subtitles || []).filter((item) => {
    try {
      LensMedia.safeUrl(item.subtitle_url, true);
      return true;
    } catch {
      return false;
    }
  });
  $("subtitle-track").replaceChildren(
    option("", "选择字幕"),
    ...subtitleTracks.map((item, i) =>
      option(String(i), item.lan_doc || item.lan || `字幕 ${i + 1}`),
    ),
  );
  if (subtitleTracks.length) $("subtitle-track").value = "0";
  notice(
    subtitleTracks.length
      ? `找到 ${subtitleTracks.length} 个字幕轨道。`
      : "当前视频没有可获取的字幕轨道。",
  );
}
bind("get-subtitles", () => {
  stopAutomatic();
  return readSubtitles();
});
bind("export-subtitle", async () => {
  const selected = subtitleTracks[Number($("subtitle-track").value)];
  if (!selected || $("subtitle-track").value === "")
    throw new Error("请选择已有字幕轨道");
  if (
    !(await chrome.permissions.contains({ origins: CDN })) &&
    !(await chrome.permissions.request({ origins: CDN }))
  )
    throw new Error("字幕资源访问未授权");
  const token = generation,
    data = await request("subtitle", { url: selected.subtitle_url });
  if (token !== generation) return;
  subtitleData = data;
  const format = $("subtitle-format").value;
  saveFile(
    LensMedia.subtitle(data, format),
    `${LensMedia.cleanName(video.title)}-P${page().page}-${LensMedia.cleanName(selected.lan || "subtitle")}.${format}`,
  );
  notice("字幕已保存，可使用文本检索。");
  renderSubtitle();
});
function renderSubtitle() {
  const query = BiliSearchLens.normalize($("subtitle-query").value);
  $("subtitle-results").replaceChildren(
    ...(subtitleData?.body || [])
      .filter((item) => BiliSearchLens.normalize(item.content).includes(query))
      .slice(0, 200)
      .map((item) => {
        const button = document.createElement("button");
        button.textContent = `${LensDanmaku.assTime(item.from)} ${item.content}`;
        button.addEventListener("click", () =>
          seek(item.from).catch((error) => notice(error.message, true)),
        );
        return button;
      }),
  );
}
$("subtitle-query").addEventListener("input", renderSubtitle);
function renderBookmarks() {
  $("bookmark-list").replaceChildren(
    ...settings.bookmarks
      .filter((b) => b.bvid === video?.bvid)
      .map((b) => {
        const line = document.createElement("div");
        const button = document.createElement("button");
        button.textContent = `P${b.page || 1} · ${LensDanmaku.assTime(b.time)} ${b.note}`;
        button.addEventListener("click", () =>
          seek(b.time, b.cid || video.pages[0].cid).catch((error) =>
            notice(error.message, true),
          ),
        );
        const remove = document.createElement("button");
        remove.textContent = "删除";
        remove.setAttribute(
          "aria-label",
          `删除 P${b.page || 1} ${b.note || "时间戳"}书签`,
        );
        remove.addEventListener("click", async () => {
          try {
            settings = await LensSettings.load();
            settings.bookmarks = settings.bookmarks.filter(
              (item) =>
                !(
                  item.bvid === b.bvid &&
                  item.cid === b.cid &&
                  item.time === b.time &&
                  item.note === b.note
                ),
            );
            settings = await LensSettings.save(settings);
            renderBookmarks();
          } catch (error) {
            notice(error.message, true);
          }
        });
        line.append(button, remove);
        return line;
      }),
  );
}
bind("save-bookmark", async () => {
  page();
  settings = await LensSettings.load();
  if (settings.bookmarks.length >= 500)
    throw new Error("书签已达 500 条，请先删除或导出旧书签");
  const time = Number($("bookmark-time").value);
  if (!Number.isFinite(time) || time < 0 || time > 86400)
    throw new Error("书签时间无效");
  settings.bookmarks.push({
    bvid: video.bvid,
    cid: page().cid,
    page: page().page,
    time,
    note: $("bookmark-note").value,
  });
  settings = await LensSettings.save(settings);
  renderBookmarks();
  notice("书签已保存在本地。");
});
bind("export-bookmarks", () => {
  page();
  saveFile(
    JSON.stringify(
      settings.bookmarks.filter((b) => b.bvid === video.bvid),
      null,
      2,
    ),
    `${video.bvid}-bookmarks.json`,
    "application/json",
  );
});
const stateLabels = {
  queued: "排队",
  resolving: "解析",
  downloading: "下载中",
  paused: "已暂停",
  saved: "文件已保存",
  failed: "失败",
  cancelled: "已取消",
};
async function refreshTasks() {
  tasks = await request("tasks");
  $("track-task-section").hidden = tasks.length === 0;
  $("tasks").replaceChildren(
    ...tasks
      .slice()
      .reverse()
      .map((task) => {
        const tr = document.createElement("tr"),
          name = document.createElement("td"),
          state = document.createElement("td"),
          progress = document.createElement("td"),
          actions = document.createElement("td");
        tr.dataset.taskId = task.id;
        actions.className = "task-actions";
        progress.className = "task-progress";
        renderTaskName(name, task.title, task.part);
        renderTaskState(
          state,
          task.state,
          `${task.kind} · ${stateLabels[task.state] || task.state}`,
          task.error,
        );
        const previous = speeds.get(task.id),
          now = Date.now(),
          rate = previous
            ? Math.max(
                0,
                (((task.bytesReceived || 0) - previous.bytes) /
                  (now - previous.time)) *
                  1000,
              )
            : 0;
        speeds.set(task.id, { bytes: task.bytesReceived || 0, time: now });
        progress.textContent = `${((task.bytesReceived || 0) / 1048576).toFixed(1)} MB${task.totalBytes > 0 ? ` / ${(task.totalBytes / 1048576).toFixed(1)} MB` : ""}${rate > 0 ? ` · ${(rate / 1048576).toFixed(2)} MB/s` : ""}`;
        const available =
          task.state === "saved"
            ? ["show"]
            : task.state === "paused"
              ? ["resume", "cancel"]
              : task.state === "downloading"
                ? ["pause", "cancel"]
                : ["queued", "resolving"].includes(task.state)
                  ? ["cancel"]
                  : task.state === "failed" && task.canResume
                    ? ["resume", "retry", "cancel"]
                    : ["failed", "cancelled"].includes(task.state)
                      ? ["retry"]
                      : [];
        if (["saved", "failed", "cancelled"].includes(task.state))
          available.push("delete");
        for (const action of available) {
          const button = document.createElement("button");
          button.dataset.action = action;
          button.textContent = {
            show: "打开位置",
            resume: "继续",
            cancel: "取消",
            pause: "暂停",
            retry: "重新下载",
            delete: "删除记录",
          }[action];
          if (action === "delete")
            button.title = "仅移除任务记录，不删除已下载文件";
          button.addEventListener("click", async () => {
            try {
              await request("taskAction", { taskId: task.id, action });
              await refreshTasks();
            } catch (error) {
              notice(error.message, true);
            }
          });
          actions.append(button);
        }
        tr.append(name, state, progress, actions);
        return tr;
      }),
  );
  if (typeof refreshMediaJobs === "function") await refreshMediaJobs();
  $("queue-empty").hidden = tasks.length > 0 || !$("media-task-section").hidden;
}
bind("refresh-tasks", refreshTasks);
bind("clear-tasks", async () => {
  await request("clearTasks");
  await refreshTasks();
});
bind("run-search", async () => {
  const keyword = $("search-keyword").value.trim();
  if (!keyword) throw new Error("请输入查询词");
  await apiPermission();
  searchCancelled = false;
  $("cancel-search").disabled = false;
  const pages = Number($("search-pages").value),
    orders = $("search-multiple").checked
      ? ["totalrank", "pubdate", "click"]
      : ["totalrank"],
    candidates = new Map();
  let completed = 0;
  try {
    for (const order of orders) {
      for (let index = 1; index <= pages; index++) {
        if (searchCancelled) break;
        const data = await request("search", { keyword, page: index, order });
        for (const row of data) candidates.set(row.bvid, row);
        completed++;
        $("search-count").textContent =
          `已请求 ${completed} 页 · 去重后 ${candidates.size} 个候选`;
        if (index < pages)
          await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (searchCancelled) break;
    }
  } finally {
    $("cancel-search").disabled = true;
    const rules = BiliSearchLens.compileRules(
      keyword,
      settings.search.exclusions,
      settings.search.mode,
      settings.search,
    );
    const results = [...candidates.values()].filter(
      (row) =>
        BiliSearchLens.evaluateVideo(
          {
            title: row.title,
            description: row.description,
            tags: row.tags,
            author: row.author,
            uid: row.mid,
            views: row.play,
            pubdate: row.pubdate,
            duration: row.duration,
            tid: row.tid,
          },
          rules,
          settings.search,
        ).keep,
    );
    $("search-results").replaceChildren(
      ...results.map((row) => {
        const p = document.createElement("p"),
          a = document.createElement("a");
        a.href = `https://www.bilibili.com/video/${row.bvid}/`;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = row.title;
        p.append(a, document.createTextNode(` · ${row.author}`));
        return p;
      }),
    );
    $("search-count").textContent =
      `${searchCancelled ? "已停止 · " : ""}已请求 ${completed} 页 · 候选 ${candidates.size} 个 · ${settings.search.mode === "related" ? "谨慎筛选" : "标题规则"}保留 ${results.length} 个`;
  }
});
bind("cancel-search", () => {
  searchCancelled = true;
  notice("当前请求结束后停止后续检索。");
});
function renderSearches() {
  $("saved-searches").replaceChildren(
    ...settings.savedSearches.map((query) => {
      const button = document.createElement("button");
      button.textContent = query;
      button.addEventListener(
        "click",
        () => ($("search-keyword").value = query),
      );
      return button;
    }),
  );
}
bind("save-search", async () => {
  const query = $("search-keyword").value.trim();
  if (!query) throw new Error("请输入查询");
  settings.savedSearches = [...new Set([...settings.savedSearches, query])];
  settings = await LensSettings.save(settings);
  renderSearches();
  notice("查询已保存在本地。");
});
const initialButtons = [...document.querySelectorAll("button")].filter(
  (button) => !button.disabled,
);
initialButtons.forEach((button) => (button.disabled = true));
LensSettings.load()
  .then((value) => {
    settings = value;
    document.documentElement.dataset.theme = settings.ui.theme;
    fillRules();
    renderSearches();
    const route = new URL(location.href);
    $("video-input").value = route.searchParams.get("id") || "";
    initialButtons.forEach((button) => (button.disabled = false));
    if (embedded && $("video-input").value) return readAutomatic();
  })
  .catch((error) => notice(error.message, true));
setInterval(() => {
  if (!$("queue").hidden) refreshTasks().catch(() => {});
}, 2500);
