// One private worker / WASM instance per job. No network protocols in the core.
importScripts("ffmpeg-core.js");
const MAX_SOURCE = 128 * 1024 ** 2;
const MAX_OUTPUT = 192 * 1024 ** 2;
self.onmessage = async ({ data }) => {
  try {
    const { files, format, merge } = data;
    if (
      !["mp4", "mkv", "mp3", "aac", "m4a"].includes(format) ||
      files.length !== (merge ? 2 : 1) ||
      files.some((f) => !f.size) ||
      files.reduce((sum, f) => sum + f.size, 0) > MAX_SOURCE
    )
      throw new Error("高级转换源文件合计须为 1 字节至 128 MiB");
    const core = await createFFmpegCore();
    let tail = [];
    core.setLogger(({ message }) => {
      tail.push(message);
      tail = tail.slice(-6);
      if (/Duration:/.test(message)) {
        const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
        if (
          duration &&
          +duration[1] * 3600 + +duration[2] * 60 + +duration[3] > 3600
        )
          throw new Error("高级转换暂支持最长 1 小时");
      }
    });
    core.setProgress(({ time }) => {
      if (time > 3600 * 1000000) throw new Error("高级转换暂支持最长 1 小时");
      self.postMessage({ progress: { processedMs: Math.max(0, time / 1000) } });
    });
    core.setTimeout(10 * 60 * 1000);
    core.FS.mkdir("/input");
    core.FS.mount(
      core.WORKERFS,
      { blobs: files.map((data, index) => ({ name: `${index}.media`, data })) },
      "/input",
    );
    const args = ["-hide_banner", "-nostdin", "-i", "/input/0.media"];
    if (merge)
      args.push(
        "-i",
        "/input/1.media",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
      );
    else
      args.push(
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        format === "mp3" ? "libmp3lame" : format === "aac" ? "aac" : "copy",
      );
    if (["mp3", "aac"].includes(format)) args.push("-b:a", "192k");
    // Fixed command construction, explicit file-only protocol and bounded output.
    args.unshift("-protocol_whitelist", "file");
    args.push(
      "-fs",
      String(MAX_OUTPUT),
      "-f",
      format === "mkv" ? "matroska" : format === "mp3" ? "mp3" : "mp4",
      "/output",
    );
    const code = core.exec(...args);
    if (code !== 0)
      throw new Error(
        "内置 FFmpeg 无法处理这些轨道；请检查格式或更换轨道。" +
          tail
            .filter((x) => /Error|Invalid|not found|Unsupported/i.test(x))
            .join(" ")
            .slice(0, 300),
      );
    const bytes = core.FS.readFile("/output");
    if (!bytes.length || bytes.length >= MAX_OUTPUT)
      throw new Error("转换成品为空或达到 192 MiB 上限，未保存不完整文件");
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({
      error: String(error.message).replace(/https?:\/\/\S+/g, "[地址已隐藏]"),
    });
  }
};
