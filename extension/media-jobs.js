// Browser-owned media jobs. Legacy history is retained without reconnecting hosts.
const MEDIA_KEY = "lensMediaJobs";
let mediaRecovering = true;
async function getMediaJobs() {
  return (await chrome.storage.local.get(MEDIA_KEY))[MEDIA_KEY] || [];
}
async function saveMediaJobs(jobs) {
  const active = jobs.filter((j) =>
    ["waiting", "processing", "cancelling"].includes(j.state),
  );
  await chrome.storage.local.set({
    [MEDIA_KEY]: [
      ...jobs.filter((j) => !active.includes(j)).slice(-100),
      ...active,
    ],
  });
}
async function updateMediaJob(identifier, change) {
  const jobs = await getMediaJobs(),
    job = jobs.find((j) => j.id === identifier);
  if (job) {
    Object.assign(job, change);
    await saveMediaJobs(jobs);
  }
  return job;
}
async function recoverMediaJobs() {
  if (!mediaRecovering) return;
  const jobs = await getMediaJobs();
  for (const job of jobs)
    if (job.engine !== "browser") {
      job.engine = "legacy";
      if (["waiting", "processing", "cancelling"].includes(job.state)) {
        job.state = "failed";
        job.error =
          "此旧版任务使用已移除的处理方式；请在插件内重新创建任务。已保存文件保留。";
      }
    }
  await saveMediaJobs(jobs);
  mediaRecovering = false;
}
async function pumpMediaJobs() {
  await recoverMediaJobs();
  await pumpBrowserJobs();
}
async function mediaAction(message) {
  const jobs = await getMediaJobs(),
    job = jobs.find((j) => j.id === message.jobId);
  if (!job) throw new Error("成品任务不存在");
  if (message.action === "show") {
    if (
      job.engine !== "browser" ||
      job.state !== "completed" ||
      !Number.isInteger(job.downloadId)
    )
      throw new Error("只有已保存的插件内成品可以打开文件夹");
    if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
      throw new Error("下载权限未授权，无法打开文件夹");
    const [item] = await chrome.downloads.search({ id: job.downloadId });
    if (
      !item ||
      item.state !== "complete" ||
      item.filename !== job.outputFilename
    )
      throw new Error("浏览器下载记录已清除或不匹配，无法定位成品文件");
    if (item.exists === false)
      throw new Error("成品文件已移动或删除，无法在原文件夹中定位");
    await chrome.downloads.show(job.downloadId);
    return true;
  }
  if (message.action === "delete") {
    if (!["completed", "failed", "cancelled"].includes(job.state))
      throw new Error("请先停止任务，等待清理完成后再删除记录");
    await saveMediaJobs(jobs.filter((item) => item.id !== job.id));
    return true;
  }
  if (job.engine === "browser") return browserAction(message, job);
  throw new Error("旧版任务仅支持查看或删除记录；请重新创建插件内任务");
}
