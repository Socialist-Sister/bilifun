// The service worker owns persistent state; offscreen owns bytes and lifetime.
let browserRecovering = true;
const browserResolvers = new Map();
const browserStates = ["waiting", "processing", "cancelling"];
async function remuxContext() {
  return (
    await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("remux.html")],
    })
  )[0];
}
async function remuxMessage(op, data = {}) {
  return chrome.runtime.sendMessage({ target: "remux", op, ...data });
}
async function ensureRemux(signal) {
  if (!(await remuxContext()))
    await chrome.offscreen.createDocument({
      url: "remux.html",
      reasons: ["BLOBS"],
      justification:
        "将磁盘缓存的音视频重封装为 MP4，并持有下载所需的 Blob URL；关闭面板后继续处理。",
    });
  // createDocument can resolve before the module graph has installed its listener.
  // Probe readiness, including after a worker restart, without restarting a job.
  for (let attempt = 0; attempt < 50; attempt++) {
    signal?.throwIfAborted();
    try {
      if (Array.isArray((await remuxMessage("status"))?.active)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("后台重封装页面未能就绪，请重试");
}
async function recoverBrowserJobs(jobs) {
  if (!browserRecovering) return;
  if (await remuxContext()) await ensureRemux();
  const live = (await remuxContext())
    ? (await remuxMessage("status"))?.active || []
    : [];
  for (const job of jobs) {
    if (
      job.engine !== "browser" ||
      !["processing", "cancelling"].includes(job.state) ||
      live.includes(job.id)
    )
      continue;
    const item = job.downloadId
      ? (await chrome.downloads.search({ id: job.downloadId }))[0]
      : null;
    if (item?.state === "complete")
      Object.assign(job, {
        state: "completed",
        outputFilename: item.filename,
        outputBytes: item.fileSize,
        completedAt: Date.now(),
      });
    else {
      if (item?.state === "in_progress")
        await chrome.downloads.cancel(item.id).catch(() => {});
      Object.assign(job, {
        state: "failed",
        error: "浏览器后台曾中断；请点击重试，临时缓存将在下次任务清理",
        completedAt: Date.now(),
      });
    }
    await clearLocalInput(job).catch(() => {});
  }
  await saveMediaJobs(jobs);
  browserRecovering = false;
}
async function pumpBrowserJobs() {
  const jobs = await getMediaJobs();
  await recoverBrowserJobs(jobs);
  if (
    jobs.some(
      (job) =>
        job.engine === "browser" &&
        ["processing", "cancelling"].includes(job.state),
    )
  )
    return;
  // A completed job may still be releasing its disk files and Blob URL.
  if (await remuxContext()) {
    if ((await remuxMessage("status"))?.active?.length) return;
  }
  const job = jobs.find(
    (job) => job.engine === "browser" && job.state === "waiting",
  );
  if (!job) return;
  const controller = new AbortController();
  browserResolvers.set(job.id, controller);
  let dispatched = false;
  try {
    const streams = job.localId
      ? null
      : await resources(job.bvid, job.cid, controller.signal);
    const tracks = job.localId
      ? []
      : [
          streams.video.find((track) => track.key === job.videoKey),
          streams.audio.find((track) => track.key === job.audioKey),
        ].filter((track, index) => (index ? true : Boolean(job.videoKey)));
    if (tracks.some((track) => !track))
      throw new Error("所选轨道已失效，请重新读取视频并选择轨道");
    controller.signal.throwIfAborted();
    if (!job.localId) await prepareHeaders();
    await ensureRemux(controller.signal);
    controller.signal.throwIfAborted();
    job.state = "processing";
    job.startedAt = Date.now();
    delete job.error;
    await saveMediaJobs(jobs);
    dispatched = true;
    const response = await remuxMessage("start", { job, tracks });
    if (!response?.started)
      throw new Error(response?.error || "后台重封装页面启动失败");
  } catch (error) {
    Object.assign(job, {
      state: controller.signal.aborted ? "cancelled" : "failed",
      error: String(error.message).replace(/https?:\/\/\S+/g, "[地址已隐藏]"),
      completedAt: Date.now(),
    });
    await saveMediaJobs(jobs);
    if (!dispatched) await clearLocalInput(job).catch(() => {});
    // Cancellation during module readiness has no running job to emit Idle.
    if (!dispatched && (await remuxContext()))
      await chrome.offscreen.closeDocument().catch(() => {});
    // Skip a failed queued item without requiring an open tools page.
    setTimeout(() => serial(pumpBrowserJobs).catch(() => {}), 0);
  } finally {
    browserResolvers.delete(job.id);
  }
}
async function createBrowserJob(message) {
  const audioOnly = message.op === "enqueueAudio";
  const format = audioOnly ? message.format : message.container;
  if (!(audioOnly ? ["m4a", "mp3", "aac"] : ["mp4", "mkv"]).includes(format))
    throw new Error("成品格式不支持");
  if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
    throw new Error("请先授权下载权限");
  await requireApi();
  const bvid = id(message.bvid),
    pageCid = cid(message.cid);
  const view = await api.view(bvid),
    page = view.pages.find((part) => part.cid === pageCid);
  if (!page) throw new Error("分 P 不属于当前视频");
  if (page.duration > 3600)
    throw new Error("插件内成品下载暂支持最长 1 小时；可下载原始轨道");
  const streams = await resources(bvid, pageCid);
  if (
    (!audioOnly &&
      !streams.video.some((track) => track.key === message.videoKey)) ||
    !streams.audio.some((track) => track.key === message.audioKey)
  )
    throw new Error("成品下载需要有效视频轨道和音轨");
  const jobs = await getMediaJobs();
  const duplicate = jobs.find(
    (job) =>
      job.engine === "browser" &&
      browserStates.includes(job.state) &&
      job.bvid === bvid &&
      job.cid === pageCid &&
      job.videoKey === (audioOnly ? undefined : message.videoKey) &&
      job.audioKey === message.audioKey &&
      job.format === format,
  );
  if (duplicate) return duplicate;
  if (jobs.filter((job) => browserStates.includes(job.state)).length >= 30)
    throw new Error("成品队列已达 30 项");
  const settings = await LensSettings.load();
  const job = {
    id: crypto.randomUUID(),
    engine: "browser",
    kind: audioOnly ? (format === "m4a" ? "remux" : "transcode") : "remux",
    format,
    bvid,
    cid: pageCid,
    videoKey: audioOnly ? undefined : message.videoKey,
    audioKey: message.audioKey,
    title: view.title,
    part: page.part,
    duration: page.duration,
    state: "waiting",
    createdAt: Date.now(),
    relativeFilename: LensMedia.filename(
      settings.downloads.filename,
      view,
      page,
      "complete",
      format === "aac" ? "m4a" : format,
    ),
  };
  jobs.push(job);
  await saveMediaJobs(jobs);
  return job;
}
async function createLocalJob(message) {
  if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
    throw new Error("请先授权下载权限");
  if (
    !/^[a-f0-9-]{36}$/.test(message.localId || "") ||
    !["mp4", "mkv", "mp3", "aac", "m4a"].includes(message.format)
  )
    throw new Error("本地处理参数无效");
  const root = await navigator.storage.getDirectory();
  const directory = await (
    await root.getDirectoryHandle("lens-input-v1")
  ).getDirectoryHandle(message.localId);
  const audio = await (await directory.getFileHandle("audio")).getFile();
  const video = ["mp4", "mkv"].includes(message.format)
    ? await (await directory.getFileHandle("video")).getFile()
    : null;
  if (
    !audio.size ||
    (video && !video.size) ||
    audio.size + (video?.size || 0) > 128 * 1024 ** 2
  )
    throw new Error("源文件合计须为 1 字节至 128 MiB");
  const jobs = await getMediaJobs();
  if (jobs.some((j) => j.localId === message.localId))
    throw new Error("此文件处理任务已创建");
  if (jobs.filter((j) => browserStates.includes(j.state)).length >= 30)
    throw new Error("成品队列已达 30 项");
  const title = LensMedia.cleanName(
    String(message.title || "本地文件").slice(0, 200),
  );
  const job = {
    id: crypto.randomUUID(),
    engine: "browser",
    localId: message.localId,
    kind: video ? "merge" : message.format === "m4a" ? "remux" : "transcode",
    format: message.format,
    title,
    part: "本地处理",
    duration: 0,
    state: "waiting",
    createdAt: Date.now(),
    relativeFilename:
      title + "." + (message.format === "aac" ? "m4a" : message.format),
  };
  jobs.push(job);
  await saveMediaJobs(jobs);
  return job;
}
async function browserAction(message, job) {
  if (message.action === "cancel") {
    if (job.state === "cancelled") return getMediaJobs();
    if (!browserStates.includes(job.state)) throw new Error("此任务已结束");
    browserResolvers.get(job.id)?.abort();
    if (job.state === "waiting") {
      await updateMediaJob(job.id, { state: "cancelled" });
      await clearLocalInput(job);
    } else {
      await updateMediaJob(job.id, { state: "cancelling" });
      await remuxMessage("cancel", { jobId: job.id });
    }
  } else if (["retry", "redownload"].includes(message.action)) {
    if (!["failed", "cancelled"].includes(job.state))
      throw new Error("只有失败或取消任务可重试");
    if ((job.retries || 0) >= 3)
      throw new Error("已达三次重试上限，请重新创建任务");
    if (job.localId)
      throw new Error("本地文件缓存已清理，请重新选择文件并创建任务");
    resourceCache.delete(`${job.bvid}:${job.cid}`);
    await updateMediaJob(job.id, {
      state: "waiting",
      retries: (job.retries || 0) + 1,
      error: null,
      progress: null,
      downloadId: null,
      outputFilename: null,
    });
  } else throw new Error("成品操作不支持");
  await pumpBrowserJobs();
  return getMediaJobs();
}
async function clearLocalInput(job) {
  if (!job.localId || !/^[a-f0-9-]{36}$/.test(job.localId)) return;
  const root = await navigator.storage.getDirectory();
  await (
    await root.getDirectoryHandle("lens-input-v1")
  )
    .removeEntry(job.localId, { recursive: true })
    .catch(() => {});
}
async function browserEvent(message, sender) {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("remux.html")
  )
    throw new Error("仅允许后台重封装页面报告任务");
  return serial(async () => {
    if (message.op === "browserIdle") {
      // The offscreen page has released all files and URLs before this event.
      if ((await remuxMessage("status"))?.active?.length) return true;
      await chrome.offscreen.closeDocument();
      await pumpBrowserJobs();
      return true;
    }
    const job = (await getMediaJobs()).find(
      (item) => item.id === message.jobId && item.engine === "browser",
    );
    if (!job) throw new Error("后台任务不存在");
    if (message.op === "browserProgress") {
      if (job.state === "processing")
        await updateMediaJob(job.id, { progress: message.progress });
      return true;
    }
    if (message.op === "browserSave") {
      if (
        job.state !== "processing" ||
        !message.url?.startsWith(
          `blob:chrome-extension://${chrome.runtime.id}/`,
        )
      )
        throw new Error("任务已取消或成品地址无效");
      const settings = await LensSettings.load();
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: job.relativeFilename,
        saveAs: false,
        conflictAction: settings.downloads.conflictAction,
      });
      await updateMediaJob(job.id, { downloadId, outputBytes: message.bytes });
      return downloadId;
    }
    if (["browserDownload", "browserCancelSave"].includes(message.op)) {
      if (job.downloadId !== message.downloadId)
        throw new Error("下载记录不匹配");
      if (message.op === "browserCancelSave") {
        await chrome.downloads.cancel(job.downloadId).catch(() => {});
        return true;
      }
      const [item] = await chrome.downloads.search({ id: job.downloadId });
      if (!item) throw new Error("成品下载记录丢失");
      return { state: item.state, filename: item.filename, error: item.error };
    }
    if (message.op === "browserResult") {
      if (!browserStates.includes(job.state)) return true;
      const change = {
        state: message.state,
        completedAt: Date.now(),
        error: message.error,
      };
      if (message.state === "completed") {
        const [item] = await chrome.downloads.search({ id: job.downloadId });
        if (item?.state !== "complete") throw new Error("成品尚未保存完成");
        Object.assign(change, {
          outputFilename: item.filename,
          outputBytes: item.fileSize,
          codecs: message.codecs,
          progress: {
            percent: 100,
            processedMs: job.duration * 1000,
            phase: "成品已保存",
          },
        });
      } else if (!["failed", "cancelled"].includes(message.state))
        throw new Error("后台结束状态无效");
      await updateMediaJob(job.id, change);
      return true;
    }
    throw new Error("后台事件不支持");
  });
}
