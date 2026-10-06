import { LIMITS, downloadTrack, remuxFiles } from "./remux-core.js";
import { CONVERT_LIMIT, convertFiles } from "./convert.js";

const active = new Map();
const ROOT = "lens-remux-v1";
const send = async (op, data = {}) => {
  const response = await chrome.runtime.sendMessage({ op, ...data });
  if (!response?.ok) throw new Error(response?.error || "后台连接中断");
  return response.result;
};
// A fresh offscreen document has no live jobs. Only our private namespace is
// removed; interrupted browser sessions never silently restart network jobs.
const initialized = (async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(ROOT, { recursive: true }).catch((error) => {
    if (error.name !== "NotFoundError") throw error;
  });
  return root.getDirectoryHandle(ROOT, { create: true });
})();

async function run(job, tracks) {
  const controller = new AbortController(),
    signal = controller.signal;
  active.set(job.id, controller);
  let directory,
    objectUrl,
    outputId,
    reported = false;
  let latest = { phase: "准备磁盘缓存", bytes: 0, processedMs: 0, percent: 0 },
    lastReport = 0;
  const report = async (force = false) => {
    if (!force && Date.now() - lastReport < 500) return;
    lastReport = Date.now();
    await send("browserProgress", { jobId: job.id, progress: latest });
  };
  // Messages both provide liveness to recovery and keep the service worker
  // responsive while slow disk/network operations are running offscreen.
  const heartbeat = setInterval(() => report(true).catch(() => {}), 10000);
  try {
    const root = await initialized;
    directory = await root.getDirectoryHandle(job.id, { create: true });
    const estimate = await navigator.storage.estimate();
    const predicted = tracks.reduce(
      (sum, track) => sum + ((track.bandwidth || 0) * job.duration) / 8,
      0,
    );
    const advanced = job.localId || job.format !== "mp4";
    if (advanced && predicted > CONVERT_LIMIT)
      throw new Error("高级转换源文件合计超过 128 MiB，请改选较低码率");
    if (predicted > LIMITS.sourceBytes)
      throw new Error("预计音视频合计超过 2 GiB，请改选较低码率");
    if (
      estimate.quota &&
      estimate.quota - estimate.usage <
        Math.max(64 * 1024 ** 2, predicted * 2.2)
    )
      throw new Error(
        "浏览器临时存储空间不足；需要约音视频总大小的 2.2 倍空闲空间",
      );
    const files = [],
      budget = { bytes: 0 };
    if (job.localId) {
      const inputs = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("lens-input-v1");
      const source = await inputs.getDirectoryHandle(job.localId);
      for (const name of ["mp4", "mkv"].includes(job.format)
        ? ["video", "audio"]
        : ["audio"])
        files.push(await (await source.getFileHandle(name)).getFile());
    }
    for (const [index, track] of tracks.entries()) {
      signal.throwIfAborted();
      const handle = await directory.getFileHandle(`${index}.m4s`, {
        create: true,
      });
      latest.phase = index ? "下载音频到临时磁盘" : "下载视频到临时磁盘";
      await downloadTrack(
        globalThis.LensMedia.safeUrl(track.url),
        await handle.createWritable(),
        {
          signal,
          budget,
          async onSize(sourceBytes) {
            if (advanced && sourceBytes > CONVERT_LIMIT)
              throw new Error("高级转换源文件合计超过 128 MiB");
            const space = await navigator.storage.estimate();
            if (
              space.quota &&
              space.quota - space.usage < sourceBytes * 2.2 - budget.bytes
            )
              throw new Error(
                "浏览器临时存储空间不足，无法同时保留源轨道和成品",
              );
          },
          progress(update) {
            if (advanced && update.bytes > CONVERT_LIMIT)
              throw new Error("高级转换源文件合计超过 128 MiB");
            latest = {
              ...latest,
              ...update,
              percent: Math.floor(
                index * 35 +
                  (update.trackTotal
                    ? (update.trackBytes / update.trackTotal) * 35
                    : 0),
              ),
            };
            report().catch(() => {});
          },
        },
      );
      files.push(await handle.getFile());
      if (advanced && budget.bytes > CONVERT_LIMIT)
        throw new Error("高级转换源文件合计超过 128 MiB");
    }
    const outputExtension = job.format === "aac" ? "m4a" : job.format;
    const handle = await directory.getFileHandle(`output.${outputExtension}`, {
      create: true,
    });
    latest.phase =
      job.kind === "transcode"
        ? "内置 FFmpeg 音频转码"
        : `无损重封装 ${job.format.toUpperCase()}`;
    const options = {
      signal,
      progress(update) {
        latest = {
          ...latest,
          ...update,
          percent:
            70 +
            Math.min(
              25,
              Math.floor(
                (update.processedMs / Math.max(1, job.duration * 1000)) * 25,
              ),
            ),
        };
        report().catch(() => {});
      },
    };
    const result =
      job.format !== "mp4"
        ? await convertFiles(
            files,
            job.format,
            await handle.createWritable(),
            options,
          )
        : await remuxFiles(
            files[0],
            files[1],
            await handle.createWritable(),
            options,
          );
    signal.throwIfAborted();
    const mime = {
      mp4: "video/mp4",
      mkv: "video/x-matroska",
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
    }[outputExtension];
    objectUrl = URL.createObjectURL(
      new Blob([await handle.getFile()], { type: mime }),
    );
    latest = { ...latest, phase: "保存成品到下载目录", percent: 97 };
    await report(true);
    outputId = await send("browserSave", {
      jobId: job.id,
      url: objectUrl,
      bytes: result.bytes,
    });
    while (true) {
      signal.throwIfAborted();
      const item = await send("browserDownload", {
        jobId: job.id,
        downloadId: outputId,
      });
      if (item.state === "complete") {
        await send("browserResult", {
          jobId: job.id,
          state: "completed",
          outputFilename: item.filename,
          outputBytes: result.bytes,
          codecs: result.codecs,
        });
        reported = true;
        break;
      }
      if (item.state === "interrupted")
        throw new Error(`成品保存中断：${item.error || "下载失败"}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    if (outputId)
      await send("browserCancelSave", {
        jobId: job.id,
        downloadId: outputId,
      }).catch(() => {});
    await send("browserResult", {
      jobId: job.id,
      state: signal.aborted ? "cancelled" : "failed",
      error: signal.aborted
        ? "任务已取消，临时文件已清理"
        : error.name === "QuotaExceededError"
          ? "浏览器临时存储空间不足，请释放空间或改选较低码率"
          : String(error.message).replace(/https?:\/\/\S+/g, "[地址已隐藏]"),
    }).catch(() => {});
    reported = true;
  } finally {
    clearInterval(heartbeat);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (directory)
      await (
        await initialized
      )
        .removeEntry(job.id, { recursive: true })
        .catch(() => {});
    if (job.localId) {
      const root = await navigator.storage.getDirectory();
      await (
        await root.getDirectoryHandle("lens-input-v1")
      )
        .removeEntry(job.localId, { recursive: true })
        .catch(() => {});
    }
    active.delete(job.id);
    // Terminal persistence precedes queue advancement and document teardown.
    await send("browserIdle", { jobId: job.id, reported }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message?.target !== "remux" ||
    sender.id !== chrome.runtime.id ||
    (sender.url && sender.url !== chrome.runtime.getURL("background.js"))
  )
    return;
  if (message.op === "status") respond({ active: [...active.keys()] });
  else if (message.op === "start") {
    if (active.size) respond({ error: "后台已有正在运行的重封装任务" });
    else {
      run(message.job, message.tracks).catch(() => {});
      respond({ started: true });
    }
  } else if (message.op === "cancel") {
    active.get(message.jobId)?.abort();
    respond({ cancelled: true });
  }
});
