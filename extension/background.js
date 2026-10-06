"use strict";
importScripts(
  "core.js",
  "settings.js",
  "media.js",
  "wbi.js",
  "danmaku.js",
  "api.js",
  "cache.js",
  "tags.js",
  "refill.js",
  "pagination.js",
  "media-jobs.js",
  "browser-jobs.js",
);
const api = new LensApi();
const searchPages = new LensPagination.Store(chrome.storage.session);
chrome.tabs.onRemoved.addListener((tabId) =>
  searchPages.remove(tabId).catch(() => {}),
);
const videoTags = new LensTags((videoId, options) =>
  api.tags(videoId, options),
);
const resourceRequests = new Map();
async function resourceRequest(message, sender, action) {
  if (typeof message.token !== "string") return action({});
  const token = requestToken(sender, message.token),
    controller = new AbortController();
  if (resourceRequests.has(token)) throw new Error("读取请求重复");
  resourceRequests.set(token, controller);
  try {
    return await action({ signal: controller.signal, token });
  } finally {
    resourceRequests.delete(token);
  }
}
const TASK_KEY = "lensDownloadTasks",
  resourceCache = new Map(),
  taskResolvers = new Map();
let chain = Promise.resolve(),
  recovering = true,
  downloadListener = false;
function serial(action) {
  const operation = chain.then(action, action);
  chain = operation.catch(() => {});
  return operation;
}
function id(value) {
  if (typeof value !== "string" || !/^BV\w{8,22}$/.test(value))
    throw new Error("视频 ID 无效");
  return value;
}
function cid(value) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("分 P ID 无效");
  return value;
}
function trusted(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url || "");
    return (
      (url.protocol === "chrome-extension:" &&
        url.host === chrome.runtime.id) ||
      (url.protocol === "https:" &&
        ["www.bilibili.com", "search.bilibili.com"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
function extensionSender(sender) {
  return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}
function requestToken(sender, token) {
  return `${sender.documentId || sender.tab?.id || sender.url}:${String(token || "").slice(0, 100)}`;
}
async function requireApi() {
  if (
    !(await chrome.permissions.contains({
      origins: ["https://api.bilibili.com/*"],
    }))
  )
    throw new Error("请在工具页授权 B 站数据接口访问");
}
async function getTasks() {
  return (await chrome.storage.local.get(TASK_KEY))[TASK_KEY] || [];
}
async function saveTasks(tasks) {
  const protectedIds = new Set(
    (await getMediaJobs())
      .filter((j) => ["waiting", "processing", "cancelling"].includes(j.state))
      .flatMap((j) => [j.videoTask, j.audioTask]),
  );
  const active = tasks.filter(
      (t) =>
        protectedIds.has(t.id) ||
        !["saved", "failed", "cancelled"].includes(t.state),
    ),
    ended = tasks.filter(
      (t) =>
        !protectedIds.has(t.id) &&
        ["saved", "failed", "cancelled"].includes(t.state),
    ),
    limit = Math.max(0, 300 - active.length);
  await chrome.storage.local.set({
    [TASK_KEY]: [...(limit ? ended.slice(-limit) : []), ...active].sort(
      (a, b) => a.createdAt - b.createdAt,
    ),
  });
}
async function resources(bvid, pageCid, signal, token, refresh = false) {
  await requireApi();
  const key = `${bvid}:${pageCid}`,
    saved = resourceCache.get(key);
  if (!refresh && saved && Date.now() - saved.time < 600000) return saved.value;
  if (refresh) resourceCache.delete(key);
  const value = await api.streams(bvid, pageCid, 80, { signal, token });
  signal?.throwIfAborted();
  resourceCache.set(key, { time: Date.now(), value });
  return value;
}
async function prepareHeaders() {
  if (
    !chrome.declarativeNetRequest ||
    !(await chrome.permissions.contains({
      permissions: ["declarativeNetRequestWithHostAccess"],
    }))
  )
    return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [9001],
    addRules: [
      {
        id: 9001,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "referer",
              operation: "set",
              value: "https://www.bilibili.com/",
            },
          ],
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          requestDomains: [
            "api.bilibili.com",
            "bilivideo.com",
            "bilivideo.cn",
            "bilivideo.net",
            "hdslb.com",
            "biliapi.net",
          ],
          resourceTypes: ["xmlhttprequest", "other", "media"],
        },
      },
    ],
  });
}
async function reconcile() {
  const tasks = await getTasks();
  if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
    return tasks;
  if (recovering) {
    for (const task of tasks)
      if (task.state === "resolving" && !task.downloadId) {
        task.state = "failed";
        task.error = "后台在解析时中断，请手动重试以避免重复下载";
      }
    recovering = false;
  }
  for (const task of tasks) {
    if (!task.downloadId || ["saved", "cancelled"].includes(task.state))
      continue;
    const [item] = await chrome.downloads.search({ id: task.downloadId });
    if (!item) {
      task.state = "failed";
      task.error = "浏览器已无此下载记录";
      continue;
    }
    task.bytesReceived = item.bytesReceived;
    task.totalBytes = item.totalBytes;
    task.filename = item.filename;
    task.exists = item.exists;
    task.canResume = item.canResume;
    task.paused = item.paused;
    task.state =
      item.state === "complete"
        ? "saved"
        : item.state === "interrupted"
          ? "failed"
          : item.paused
            ? "paused"
            : "downloading";
    if (item.error) task.error = item.error;
    else delete task.error;
  }
  await saveTasks(tasks);
  return tasks;
}
async function pump() {
  const tasks = await reconcile(),
    settings = await LensSettings.load();
  let active = tasks.filter((t) =>
    ["downloading", "paused", "resolving"].includes(t.state),
  ).length;
  if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
    return;
  for (const task of tasks) {
    if (active >= settings.downloads.concurrent) break;
    if (task.state !== "queued") continue;
    task.state = "resolving";
    await saveTasks(tasks);
    const controller = new AbortController();
    taskResolvers.set(task.id, controller);
    try {
      const tracks = await resources(task.bvid, task.cid, controller.signal),
        track = [...tracks.video, ...tracks.audio, ...tracks.direct].find(
          (t) => t.key === task.trackKey,
        );
      if (!track) throw new Error("轨道已经失效，请重新选择清晰度或编码");
      if (controller.signal.aborted) throw new Error("任务已取消");
      await prepareHeaders();
      task.downloadId = await chrome.downloads.download({
        url: track.url,
        filename: task.relativeFilename,
        conflictAction: settings.downloads.conflictAction,
        saveAs: false,
      });
      task.state = "downloading";
      task.startedAt = Date.now();
      active++;
    } catch (error) {
      task.state = controller.signal.aborted ? "cancelled" : "failed";
      task.error = String(error.message).replace(
        /https?:\/\/\S+/g,
        "[地址已隐藏]",
      );
    }
    taskResolvers.delete(task.id);
    await saveTasks(tasks);
  }
  await pumpMediaJobs();
}
async function queueTracks(message) {
  if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
    throw new Error("请先授权下载权限");
  await requireApi();
  const bvid = id(message.bvid),
    pageCid = cid(message.cid),
    view = await api.view(bvid),
    page = view.pages.find((p) => p.cid === pageCid);
  if (!page) throw new Error("分 P 不属于当前视频");
  const tracks = await resources(bvid, pageCid),
    keys = Array.isArray(message.keys) ? [...new Set(message.keys)] : [];
  if (
    !keys.length ||
    keys.length > 3 ||
    keys.some((k) => typeof k !== "string")
  )
    throw new Error("请选择 1–3 条有效轨道");
  const selected = keys.map((key) =>
    [...tracks.video, ...tracks.audio, ...tracks.direct].find(
      (t) => t.key === key,
    ),
  );
  if (selected.some((t) => !t)) throw new Error("轨道无效，请重新获取");
  const settings = await LensSettings.load(),
    tasks = await getTasks(),
    created = [];
  for (const track of selected) {
    let task = tasks.find(
      (t) =>
        t.bvid === bvid &&
        t.cid === pageCid &&
        t.trackKey === track.key &&
        ["queued", "resolving", "downloading", "paused"].includes(t.state),
    );
    if (!task) {
      task = {
        id: crypto.randomUUID(),
        bvid,
        cid: pageCid,
        trackKey: track.key,
        kind: track.kind,
        title: view.title,
        part: page.part,
        duration: page.duration,
        state: "queued",
        createdAt: Date.now(),
        relativeFilename: LensMedia.filename(
          settings.downloads.filename,
          view,
          page,
          track.kind,
          track.extension,
        ),
      };
      tasks.push(task);
    }
    created.push(task);
  }
  await saveTasks(tasks);
  return created;
}
async function handle(message, sender) {
  if (
    !trusted(sender) ||
    !message ||
    typeof message !== "object" ||
    typeof message.op !== "string"
  )
    throw new Error("请求来源或格式不支持");
  const op = message.op;
  if (op === "settingsLoad") return LensSettings.load();
  if (op === "settingsSave") return LensSettings.save(message.settings);
  if (op === "openSearch") {
    const keyword =
      typeof message.keyword === "string"
        ? message.keyword.trim().slice(0, 200)
        : "";
    await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `search.html?q=${encodeURIComponent(keyword)}`,
      ),
    });
    return true;
  }
  if (op === "openTools") {
    const data = LensMedia.videoFromUrl(message.url);
    if (!data) throw new Error("仅支持普通投稿视频页面");
    return chrome.tabs
      .create({
        url: chrome.runtime.getURL(
          `tools.html?id=${encodeURIComponent(data.id)}&p=${data.page}`,
        ),
      })
      .then(() => true);
  }
  if (op === "openSettings") {
    await chrome.runtime.openOptionsPage();
    return true;
  }
  if (op === "view") {
    return resourceRequest(message, sender, async (options) => {
      await requireApi();
      await prepareHeaders();
      return api.view(message.id, options);
    });
  }
  if (op === "tagStatus")
    return chrome.permissions.contains({
      origins: ["https://api.bilibili.com/*"],
    });
  if (op === "videoTags") {
    return videoTags.get(
      message.id,
      requestToken(sender, message.token),
      async () => {
        await requireApi();
        await prepareHeaders();
      },
    );
  }
  if (op === "refillPage") {
    if (
      sender.frameId !== 0 ||
      typeof message.token !== "string" ||
      !message.token ||
      message.token.length > 100
    )
      throw new Error("补位仅允许搜索页主框架请求");
    // Chrome keeps sender.url at the document's committed URL after pushState.
    // Our isolated top-frame script sends its current route; keep it on the same
    // search origin and accept only the narrow, bounded search parameters.
    if (
      typeof message.url !== "string" ||
      message.url.length > 4000 ||
      new URL(sender.url).origin !== "https://search.bilibili.com" ||
      new URL(message.url).origin !== new URL(sender.url).origin
    )
      throw new Error("补位来源仅支持当前搜索域名");
    const context = LensRefill.context(message.url, message.pageSize);
    return resourceRequest(message, sender, async (options) => {
      await requireApi();
      await prepareHeaders();
      return api.refillPage(context, message.page, options);
    });
  }
  if (op === "searchPageRecord") {
    if (
      sender.frameId !== 0 ||
      !Number.isInteger(sender.tab?.id) ||
      typeof message.url !== "string" ||
      message.url.length > 4000 ||
      new URL(sender.url).origin !== "https://search.bilibili.com" ||
      typeof message.rule !== "string" ||
      message.rule.length > 40000
    )
      throw new Error("分页记录仅允许搜索页主框架请求");
    const context = LensRefill.context(message.url, message.pageSize),
      source = JSON.stringify({
        path: new URL(message.url).pathname.replace(/\/$/, ""),
        ...context,
        page: undefined,
        // DOM batches and responsive layouts may temporarily change the slot
        // count. Identifier ownership is independent of API page partitions.
        pageSize: undefined,
        rule: message.rule,
      }),
      hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(source),
      ),
      scope = [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return searchPages.run(sender.tab.id, scope, context.page, message.ids);
  }
  if (op === "segment") {
    await requireApi();
    const index = Number(message.index);
    if (!Number.isInteger(index) || index < 1 || index > 200)
      throw new Error("弹幕分段超出范围");
    const pageCid = cid(message.cid),
      key = `${pageCid}:${index}`,
      cached = await LensCache.get(key).catch(() => null);
    if (cached) return cached;
    const rows = await api.segment(
      pageCid,
      index,
      requestToken(sender, message.token),
    );
    await LensCache.put(key, rows).catch(() => {});
    return rows;
  }
  if (op === "cancelRequest") {
    api.cancel(requestToken(sender, message.token));
    resourceRequests.get(requestToken(sender, message.token))?.abort();
    videoTags.cancel(requestToken(sender, message.token));
    return true;
  }
  if (op === "seek") {
    if (
      !extensionSender(sender) ||
      !Number.isFinite(message.time) ||
      message.time < 0 ||
      message.time > 86400
    )
      throw new Error("播放时间无效");
    const bvid = id(message.bvid),
      tabs = await chrome.tabs.query({});
    let delivered = 0;
    for (const tab of tabs) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          op: "seek",
          bvid,
          cid: message.cid,
          time: message.time,
        });
        if (result?.ok) delivered++;
      } catch {}
    }
    return delivered;
  }
  // Downloads, conversion jobs, and resource URLs are accessible only to our own pages.
  if (!extensionSender(sender)) throw new Error("此操作仅能在扩展工具页执行");
  if (op === "clearCache") {
    await LensCache.clear();
    await videoTags.clear();
    return true;
  }
  if (op === "streams")
    return resourceRequest(message, sender, (options) =>
      resources(
        id(message.bvid),
        cid(message.cid),
        options.signal,
        options.token,
        message.refresh === true,
      ),
    );
  if (op === "playerInfo")
    return resourceRequest(message, sender, async (options) => {
      await requireApi();
      return api.player(id(message.bvid), cid(message.cid), options);
    });
  if (op === "subtitle") {
    await requireApi();
    return api.subtitle(message.url);
  }
  if (op === "searchPage") {
    if (!extensionSender(sender)) throw new Error("独立搜索仅支持扩展页面");
    return resourceRequest(message, sender, async (options) => {
      await requireApi();
      return api.searchPage(
        message.keyword,
        message.page,
        message.order,
        options,
      );
    });
  }
  if (op === "search") {
    await requireApi();
    return api.search(
      String(message.keyword || ""),
      Number(message.page),
      String(message.order),
    );
  }
  if (op === "enqueue")
    return serial(async () => {
      await queueTracks(message);
      await pump();
      return getTasks();
    });
  if (op === "mediaJobs")
    return serial(async () => {
      await pump();
      return getMediaJobs();
    });
  if (op === "mediaAction") {
    if (message.action === "cancel") {
      browserResolvers.get(message.jobId)?.abort();
      if (await remuxContext())
        remuxMessage("cancel", { jobId: message.jobId }).catch(() => {});
      const jobs = await getMediaJobs(),
        job = jobs.find((j) => j.id === message.jobId);
      if (job)
        for (const taskId of [job.videoTask, job.audioTask])
          if (
            !jobs.some(
              (other) =>
                other.id !== job.id &&
                ["waiting", "processing", "cancelling"].includes(other.state) &&
                [other.videoTask, other.audioTask].includes(taskId),
            )
          )
            taskResolvers.get(taskId)?.abort();
    }
    return serial(() => mediaAction(message));
  }
  if (op === "clearMediaJobs")
    return serial(async () => {
      const remaining = (await getMediaJobs()).filter((j) =>
        ["waiting", "processing", "cancelling"].includes(j.state),
      );
      await saveMediaJobs(remaining);
      return remaining;
    });
  if (op === "enqueueVideo" || op === "enqueueAudio" || op === "enqueueLocal")
    return serial(async () => {
      const job =
        op === "enqueueLocal"
          ? await createLocalJob(message)
          : await createBrowserJob(message);
      await pumpBrowserJobs();
      return (await getMediaJobs()).find((item) => item.id === job.id);
    });
  if (op === "tasks")
    return serial(async () => {
      await pump();
      return getTasks();
    });
  if (op === "taskAction") {
    if (message.action === "cancel") taskResolvers.get(message.taskId)?.abort();
    return serial(async () => {
      const tasks = await getTasks(),
        task = tasks.find((t) => t.id === message.taskId);
      if (!task) throw new Error("任务不存在");
      if (message.action === "delete") {
        if (!["saved", "failed", "cancelled"].includes(task.state))
          throw new Error("请先停止下载，再删除任务记录");
        if (
          (await getMediaJobs()).some(
            (job) =>
              ["waiting", "processing", "cancelling"].includes(job.state) &&
              [job.videoTask, job.audioTask].includes(task.id),
          )
        )
          throw new Error(
            "成品任务仍在使用此轨道，请等待或停止成品任务后再删除记录",
          );
        await saveTasks(tasks.filter((item) => item.id !== task.id));
        return true;
      } else if (message.action === "cancel") {
        if (task.downloadId && ["downloading", "paused"].includes(task.state))
          await chrome.downloads.cancel(task.downloadId);
        task.state = "cancelled";
      } else if (message.action === "pause") {
        await chrome.downloads.pause(task.downloadId);
        task.state = "paused";
      } else if (message.action === "resume") {
        await chrome.downloads.resume(task.downloadId);
        task.state = "downloading";
      } else if (message.action === "retry") {
        if (task.state !== "failed" && task.state !== "cancelled")
          throw new Error("只有失败或取消的任务可重试");
        task.retries = (task.retries || 0) + 1;
        if (task.retries > 3)
          throw new Error("任务已达重试上限，请重新创建任务");
        resourceCache.delete(`${task.bvid}:${task.cid}`);
        delete task.downloadId;
        delete task.error;
        delete task.canResume;
        task.bytesReceived = 0;
        task.totalBytes = 0;
        task.state = "queued";
      } else if (message.action === "show") {
        await chrome.downloads.show(task.downloadId);
        return true;
      } else throw new Error("任务操作不支持");
      await saveTasks(tasks);
      await pump();
      return getTasks();
    });
  }
  if (op === "clearTasks")
    return serial(async () => {
      const protectedIds = new Set(
        (await getMediaJobs())
          .filter((j) =>
            ["waiting", "processing", "cancelling"].includes(j.state),
          )
          .flatMap((j) => [j.videoTask, j.audioTask]),
      );
      const tasks = (await getTasks()).filter(
        (t) =>
          protectedIds.has(t.id) ||
          !["saved", "failed", "cancelled"].includes(t.state),
      );
      await saveTasks(tasks);
      return tasks;
    });

  if (op === "diagnostics") {
    const settings = await LensSettings.load();
    return {
      version: chrome.runtime.getManifest().version,
      modules: settings.modules,
      taskCounts: (await getTasks()).reduce(
        (all, t) => ((all[t.state] = (all[t.state] || 0) + 1), all),
        {},
      ),
      permissions: await chrome.permissions.getAll(),
      recentErrors:
        (await chrome.storage.local.get("lensRecentErrors")).lensRecentErrors ||
        [],
    };
  }
  throw new Error("操作未实现");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === "remux") return;
  (message?.op?.startsWith("browser")
    ? browserEvent(message, sender)
    : handle(message, sender)
  )
    .then((result) => respond({ ok: true, result }))
    .catch(async (error) => {
      // A slow or broken diagnostic store must not delay the operation's error reply.
      respond({
        ok: false,
        error: String(error.message || "操作失败").replace(
          /https?:\/\/\S+/g,
          "[地址已隐藏]",
        ),
      });
      try {
        if (trusted(sender) && message?.op !== "diagnostics") {
          const reason = /风控|验证/.test(error.message)
            ? "站点要求验证"
            : /取消|超时/.test(error.message)
              ? "请求取消或超时"
              : /授权|权限|仅能/.test(error.message)
                ? "权限或来源限制"
                : /不存在|失效/.test(error.message)
                  ? "资源不可用"
                  : "操作失败，请查看工具页提示";
          const prior =
            (await chrome.storage.local.get("lensRecentErrors"))
              .lensRecentErrors || [];
          await chrome.storage.local
            .set({
              lensRecentErrors: [
                ...prior.slice(-19),
                {
                  time: new Date().toISOString(),
                  operation: String(message.op)
                    .slice(0, 40)
                    .replace(/[^a-zA-Z]/g, ""),
                  reason,
                },
              ],
            })
            .catch(() => {});
        }
      } catch {}
    });
  return true;
});
function listenDownloads() {
  if (!downloadListener && chrome.downloads) {
    chrome.downloads.onChanged.addListener(() => {
      serial(pump).catch(() => {});
    });
    downloadListener = true;
  }
}
listenDownloads();
chrome.runtime.onStartup.addListener(() => {
  serial(pump).catch(() => {});
});
chrome.permissions.onAdded.addListener(() => {
  listenDownloads();
  prepareHeaders().catch(() => {});
  serial(pump).catch(() => {});
});
