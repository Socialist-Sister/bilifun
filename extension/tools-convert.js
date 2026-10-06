"use strict";
async function conversionPermission() {
  const permissions = {
    permissions: ["downloads", "declarativeNetRequestWithHostAccess"],
    origins: ["https://api.bilibili.com/*", ...CDN],
  };
  if (
    !(await chrome.permissions.contains(permissions)) &&
    !(await chrome.permissions.request(permissions))
  )
    throw new Error("下载权限未授权");
}
async function downloadAudio(format) {
  const part = page();
  if (!streams || !$("audio-track").value)
    throw new Error("请先读取并选择音轨");
  await conversionPermission();
  await request("enqueueAudio", {
    bvid: video.bvid,
    cid: part.cid,
    audioKey: $("audio-track").value,
    format,
  });
  notice("音频任务已加入队列；在插件内处理并保存。");
  document.querySelector('[data-tab="queue"]').click();
  await refreshTasks();
}
bind("convert-current-audio", () => downloadAudio($("audio-format").value));
bind("convert-local", async () => {
  const format = $("local-format").value;
  const audio = $("local-audio").files[0],
    videoFile = ["mp4", "mkv"].includes(format)
      ? $("local-video").files[0]
      : null;
  if (!audio || (["mp4", "mkv"].includes(format) && !videoFile))
    throw new Error("请选择所需音频和视频文件");
  if (
    !audio.size ||
    (videoFile && !videoFile.size) ||
    audio.size + (videoFile?.size || 0) > 128 * 1024 ** 2
  )
    throw new Error("源文件合计须为 1 字节至 128 MiB");
  if (
    !(await chrome.permissions.contains({ permissions: ["downloads"] })) &&
    !(await chrome.permissions.request({ permissions: ["downloads"] }))
  )
    throw new Error("下载权限未授权");
  const root = await navigator.storage.getDirectory();
  const inputs = await root.getDirectoryHandle("lens-input-v1", {
    create: true,
  });
  const localId = crypto.randomUUID();
  const directory = await inputs.getDirectoryHandle(localId, { create: true });
  let queued = false;
  try {
    for (const [name, file] of [
      ["audio", audio],
      ["video", videoFile],
    ]) {
      if (!file) continue;
      const writable = await (
        await directory.getFileHandle(name, { create: true })
      ).createWritable();
      try {
        await writable.write(file);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    }
    await request("enqueueLocal", {
      localId,
      format,
      title: (videoFile || audio).name.replace(/\.[^.]+$/, ""),
    });
    queued = true;
    $("local-audio").value = "";
    $("local-video").value = "";
    notice("已加入插件内处理队列，源文件保留，生成成品后可打开文件夹。");
    await refreshTasks();
  } finally {
    if (!queued)
      await inputs.removeEntry(localId, { recursive: true }).catch(() => {});
  }
});
