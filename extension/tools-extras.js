"use strict";
const extraSection = document.createElement("details");
extraSection.innerHTML =
  '<summary>分 P 弹幕批量导出</summary><p class="muted">最多 30 个分 P、合计 60 段；顺序获取，可取消。缓存有效期 15 分钟。导出 ZIP 包最大 30 MB。</p><button id="prepare-dm-batch">列出当前视频分 P</button><div id="dm-batch-pages"></div><button id="batch-danmaku">获取勾选分 P 并导出 ZIP</button><p id="batch-dm-status" role="status"></p>';
$("danmaku").append(extraSection);
bind("prepare-dm-batch", () => {
  page();
  $("dm-batch-pages").replaceChildren(
    ...video.pages.map((part) => {
      const label = document.createElement("label"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.value = part.cid;
      label.append(
        box,
        document.createTextNode(`P${part.page} · ${part.part}`),
      );
      return label;
    }),
  );
});
function filterBatch(data, rules) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL("filter-worker.js")),
      timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("批量过滤超过 3 秒，请简化正则"));
      }, 3000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      event.data.ok
        ? resolve(event.data.result.kept)
        : reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error("过滤线程失败"));
    };
    worker.postMessage({ rows: data, rules });
  });
}
bind("batch-danmaku", async () => {
  page();
  const parts = [...document.querySelectorAll("#dm-batch-pages input:checked")]
    .map((box) => video.pages.find((p) => p.cid === Number(box.value)))
    .filter(Boolean);
  const segmentTotal = parts.reduce(
    (sum, p) => sum + Math.max(1, Math.ceil(p.duration / 360)),
    0,
  );
  if (!parts.length || parts.length > 30 || segmentTotal > 60)
    throw new Error("请选择 1–30 个分 P，合计不超过 60 个分段");
  await apiPermission();
  const token = ++generation,
    version = partVersion,
    bvid = video.bvid,
    title = video.title,
    format = $("danmaku-format").value,
    raw = $("export-source").value === "raw",
    rules = currentRules(),
    files = [];
  let bytes = 0;
  $("cancel-danmaku").disabled = false;
  try {
    for (const part of parts) {
      const data = [],
        report = {
          bvid,
          cid: part.cid,
          fetchedAt: new Date().toISOString(),
          requestedSegments: Math.max(1, Math.ceil(part.duration / 360)),
          loadedSegments: [],
          failedSegments: [],
          cancelled: false,
        };
      let dataBytes = 0;
      for (let index = 1; index <= report.requestedSegments; index++) {
        if (token !== generation) break;
        currentToken = `batch:${token}:${part.cid}:${index}`;
        $("batch-dm-status").textContent =
          `P${part.page} · 分段 ${index}/${report.requestedSegments}`;
        try {
          const received = await request("segment", {
            cid: part.cid,
            index,
            token: currentToken,
          });
          if (token !== generation) break;
          if (data.length + received.length > 200000)
            throw new Error("弹幕超过 20 万条");
          const size = new TextEncoder().encode(
            JSON.stringify(received),
          ).length;
          if (dataBytes + size > 30 * 1024 * 1024)
            throw new Error("单个分 P 弹幕超过 30 MB");
          dataBytes += size;
          data.push(...received);
          report.loadedSegments.push(index);
        } catch (error) {
          if (token !== generation) break;
          report.failedSegments.push(index);
          if (/风控|验证|超过/.test(error.message)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (version !== partVersion) return;
      report.cancelled = token !== generation;
      const original = LensDanmaku.dedupe(data),
        selected = raw ? original : await filterBatch(original, rules),
        name = `P${String(part.page).padStart(2, "0")}-${LensMedia.cleanName(part.part)}`;
      report.originalCount = original.length;
      report.exportedCount = selected.length;
      const ass = format === "ass" ? LensDanmaku.ass(selected, rules) : null;
      if (ass)
        report.ass = { unsupported: ass.unsupported, dropped: ass.dropped };
      let output =
        format === "json"
          ? JSON.stringify(
              { coverage: report, filtered: !raw, rows: selected },
              null,
              2,
            )
          : format === "xml"
            ? LensDanmaku.xml(selected, part.cid)
            : ass.text;
      const reportText = JSON.stringify(report, null, 2);
      bytes +=
        new TextEncoder().encode(output).length +
        new TextEncoder().encode(reportText).length;
      if (bytes > 30 * 1024 * 1024)
        throw new Error("导出超过 30 MB，请减少分 P");
      files.push(
        { name: `${name}.${format}`, data: output },
        {
          name: `${name}-coverage.json`,
          data: reportText,
        },
      );
      if (token !== generation) break;
    }
    if (version !== partVersion) return;
    const blob = LensArchive.zip(files),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = LensMedia.cleanName(title) + "-danmaku.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $("batch-dm-status").textContent =
      `${token !== generation ? "已取消，导出部分已获取数据" : "批量导出完成"} · ${files.length / 2} 个分 P；每个分 P 附获取范围。`;
  } finally {
    if (version === partVersion) {
      currentToken = "";
      $("cancel-danmaku").disabled = true;
    }
  }
});
const queueExtra = document.createElement("div");
queueExtra.innerHTML =
  '<details><summary>手动导出给外部下载器</summary><p class="muted">资源链接短期有效，请自行保管。</p><button id="export-downloads">导出任务资源 JSON（最多 30 条）</button></details>';
$("queue-advanced").append(queueExtra);
bind("export-downloads", async () => {
  await apiPermission();
  const selected = (await request("tasks")).slice(-30),
    output = [];
  for (const task of selected) {
    const resources = await request("streams", {
        bvid: task.bvid,
        cid: task.cid,
      }),
      track = [
        ...resources.video,
        ...resources.audio,
        ...resources.direct,
      ].find((t) => t.key === task.trackKey);
    if (track)
      output.push({
        bvid: task.bvid,
        cid: task.cid,
        filename: task.relativeFilename,
        kind: track.kind,
        url: track.url,
      });
  }
  saveFile(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        notice: "资源链接短期有效；不包含账户 Cookie",
        tasks: output,
      },
      null,
      2,
    ),
    "bili-download-resources.json",
    "application/json",
  );
  notice(`已导出 ${output.length} 条资源描述。`);
});
const mediaSection = document.createElement("section");
mediaSection.id = "media-task-section";
mediaSection.hidden = true;
mediaSection.innerHTML =
  '<h3>视频任务</h3><div class="actions"><button id="clear-media-jobs">清除已结束记录</button></div><table class="task-list-table"><thead><tr><th>成品</th><th>状态与进度</th><th>操作</th></tr></thead><tbody id="media-jobs"></tbody></table><p class="muted">关闭面板后仍继续下载；退出浏览器会中断。</p>';
$("queue").insertBefore(mediaSection, $("track-task-section"));
bind("clear-media-jobs", async () => {
  await request("clearMediaJobs");
  await refreshTasks();
});
async function refreshMediaJobs() {
  const jobs = await request("mediaJobs");
  mediaSection.hidden = jobs.length === 0;
  $("media-jobs").replaceChildren(
    ...jobs
      .slice()
      .reverse()
      .map((job) => {
        const tr = document.createElement("tr"),
          name = document.createElement("td"),
          state = document.createElement("td"),
          actions = document.createElement("td");
        tr.dataset.jobId = job.id;
        actions.className = "task-actions";
        renderTaskName(
          name,
          job.title,
          job.part,
          `${job.format.toUpperCase()}${job.kind === "transcode" ? " · 有损转码" : ""}`,
        );
        const labels = {
          waiting: "排队 / 等待源轨道",
          processing: "处理中",
          cancelling: "正在停止并清理",
          completed: "成品已完成",
          failed: "失败",
          cancelled: "已取消",
        };
        const percent =
          job.engine === "browser"
            ? (job.progress?.percent ?? 0)
            : job.state === "completed"
              ? 100
              : job.duration > 0 && job.progress
                ? Math.max(
                    0,
                    Math.min(
                      99,
                      Math.floor(
                        (job.progress.processedMs / (job.duration * 1000)) *
                          100,
                      ),
                    ),
                  )
                : null;
        renderTaskState(
          state,
          job.state,
          labels[job.state] || job.state,
          job.error,
        );
        const metrics = document.createElement("p");
        metrics.className = "task-metrics";
        metrics.textContent = [
          job.state === "processing" ? job.progress?.phase : null,
          percent !== null ? `${percent}%` : null,
          job.progress?.processedMs
            ? `${(job.progress.processedMs / 1000).toFixed(1)} 秒`
            : null,
          job.engine === "browser" && job.progress?.bytes
            ? `${(job.progress.bytes / 1048576).toFixed(1)} MiB`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        if (metrics.textContent)
          state.insertBefore(metrics, state.querySelector(".task-error"));
        if (job.outputFilename) {
          const path = document.createElement("p");
          path.className = "muted task-path";
          path.style.overflowWrap = "anywhere";
          path.textContent = job.outputFilename;
          path.title = job.outputFilename;
          state.append(path);
        }
        const available = ["waiting", "processing", "cancelling"].includes(
          job.state,
        )
          ? ["cancel"]
          : ["failed", "cancelled"].includes(job.state)
            ? job.engine === "browser" && !job.localId
              ? ["redownload"]
              : []
            : job.state === "completed"
              ? [job.engine === "browser" ? "show" : "copy"]
              : [];
        if (["completed", "failed", "cancelled"].includes(job.state))
          available.push("delete");
        for (const action of available) {
          const button = document.createElement("button");
          button.dataset.action = action;
          button.textContent = {
            cancel: "取消",
            retry: "重试处理",
            redownload:
              job.engine === "browser" ? "重新下载" : "重新下载并重试",
            copy: "复制成品路径",
            show: "打开文件夹",
            delete: "删除记录",
          }[action];
          if (action === "delete")
            button.title = "仅移除任务记录，不删除已下载文件";
          button.disabled = job.state === "cancelling";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              if (action === "copy") {
                await navigator.clipboard.writeText(job.outputFilename);
                notice("成品路径已复制。");
              } else {
                await request("mediaAction", { jobId: job.id, action });
                if (action === "show") notice("已在文件夹中定位成品文件。");
              }
              await refreshTasks();
            } catch (cause) {
              notice(cause.message, true);
            } finally {
              button.disabled = false;
            }
          });
          actions.append(button);
        }
        tr.append(name, state, actions);
        return tr;
      }),
  );
}
