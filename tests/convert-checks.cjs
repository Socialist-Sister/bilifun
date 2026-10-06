const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
module.exports = async function ({
  check,
  request,
  waitJob,
  waitIdle,
  page,
  worker,
  root,
  directory,
  fixtures,
  bvid,
}) {
  const ffmpeg = execFileSync(
    process.env.TEST_PYTHON_EXECUTABLE,
    [
      "-c",
      "import sys;sys.path.insert(0,'artifacts/test-deps');import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())",
    ],
    { cwd: root },
  )
    .toString()
    .trim();
  function decode(job, codec, video = false) {
    assert.ok(
      job.outputFilename.endsWith(
        "." + (job.format === "aac" ? "m4a" : job.format),
      ),
    );
    assert.ok(fs.statSync(job.outputFilename).size > 100);
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
      ffmpeg,
      ["-nostdin", "-hide_banner", "-i", job.outputFilename, "-f", "null", "-"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`Audio: ${codec}`));
    if (video) assert.match(result.stderr, /Video: h264/);
    assert.equal(job.engine, "browser");
    assert.ok(Number.isInteger(job.downloadId));
  }
  await check(
    "Packaged CSP enables WASM without Native Messaging or external executable resources",
    async () => {
      const manifest = await page.evaluate(() => chrome.runtime.getManifest());
      assert.ok(
        manifest.content_security_policy.extension_pages.includes(
          "'wasm-unsafe-eval'",
        ),
      );
      assert.ok(!manifest.optional_permissions.includes("nativeMessaging"));
      for (const op of ["nativeStatus", "nativeMerge", "nativeTranscode"]) {
        const reply = await page.evaluate(
          (op) => chrome.runtime.sendMessage({ op }),
          op,
        );
        assert.equal(reply.ok, false);
      }
    },
  );
  for (const [format, codec] of [
    ["m4a", "aac"],
    ["mp3", "mp3"],
    ["aac", "aac"],
  ]) {
    await check(
      `Audio-only ${format} is saved and independently decoded without a native host`,
      async () => {
        const job = await request("enqueueAudio", {
          bvid,
          cid: 1234,
          audioKey: "audio:30280:mp4a",
          format,
        });
        decode(await waitJob(job.id), codec);
        await waitIdle();
      },
    );
  }
  await check(
    "MKV combines both selected tracks and decodes video plus audio",
    async () => {
      const job = await request("enqueueVideo", {
        bvid,
        cid: 1234,
        videoKey: "video:80:avc1",
        audioKey: "audio:30280:mp4a",
        container: "mkv",
      });
      decode(await waitJob(job.id), "aac", true);
      await waitIdle();
    },
  );
  async function local(
    format,
    audio = path.join(fixtures, "audio.m4s"),
    video,
  ) {
    await page.locator('[data-tab="queue"]').click();
    await page.locator("#queue-advanced").evaluate((el) => (el.open = true));
    await page.locator("#local-audio").setInputFiles(audio);
    if (video) await page.locator("#local-video").setInputFiles(video);
    await page.locator("#local-format").selectOption(format);
    const before = (await request("mediaJobs")).map((j) => j.id);
    await page.locator("#convert-local").click();
    for (let i = 0; i < 200; i++) {
      const jobs = await request("mediaJobs");
      const job = jobs.find((j) => !before.includes(j.id));
      if (job) return job;
      await page.waitForTimeout(50);
    }
    throw new Error(
      "Local job not created: " + (await page.locator("#status").textContent()),
    );
  }
  await check(
    "File picker merges existing files locally and cleans staged OPFS inputs",
    async () => {
      const job = await local(
        "mkv",
        undefined,
        path.join(fixtures, "video.m4s"),
      );
      decode(await waitJob(job.id), "aac", true);
      await waitIdle();
      const files = await page.evaluate(async () => {
        const dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("lens-input-v1");
        const names = [];
        for await (const key of dir.keys()) names.push(key);
        return names;
      });
      assert.deepEqual(files, []);
    },
  );
  await check(
    "Invalid local media fails explicitly, saves no incomplete output and permits record deletion",
    async () => {
      const source = path.join(directory, "invalid.mp3");
      fs.writeFileSync(source, "invalid media");
      const job = await local("mp3", source);
      const failed = await waitJob(job.id, "failed");
      assert.ok(!failed.downloadId);
      assert.match(failed.error, /内置 FFmpeg/);
      await waitIdle();
      await request("mediaAction", { jobId: job.id, action: "delete" });
    },
  );
  await check(
    "Legacy active jobs become explicit failures while completed history and files are preserved",
    async () => {
      const previous = await request("mediaJobs");
      await worker.evaluate(async () => {
        const jobs = await getMediaJobs();
        jobs.push(
          {
            id: "legacy-active",
            engine: "native",
            state: "waiting",
            title: "old",
            format: "mp4",
          },
          {
            id: "legacy-done",
            engine: "native",
            state: "completed",
            outputFilename: "C:/old.mp4",
            format: "mp4",
          },
        );
        await saveMediaJobs(jobs);
        mediaRecovering = true;
      });
      const migrated = await request("mediaJobs");
      assert.equal(
        migrated.find((j) => j.id === "legacy-active").state,
        "failed",
      );
      assert.equal(
        migrated.find((j) => j.id === "legacy-done").outputFilename,
        "C:/old.mp4",
      );
      assert.equal(migrated.length, previous.length + 2);
      await request("mediaAction", {
        jobId: "legacy-active",
        action: "delete",
      });
      await request("mediaAction", { jobId: "legacy-done", action: "delete" });
    },
  );
  await check(
    "Local input above 128 MiB is rejected before staging or queueing",
    async () => {
      await page.locator("#local-audio").evaluate((input) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(128 * 1024 ** 2 + 1)], "large.wav"),
        );
        input.files = transfer.files;
      });
      await page.locator("#local-format").selectOption("mp3");
      const before = (await request("mediaJobs")).length;
      await page.locator("#convert-local").click();
      await page.waitForFunction(() =>
        document.getElementById("status").textContent.includes("128 MiB"),
      );
      assert.equal((await request("mediaJobs")).length, before);
      await page.locator("#local-audio").setInputFiles([]);
    },
  );
  await check(
    "Cancellation terminates a working WASM encoder, saves no partial output and cleans local inputs",
    async () => {
      const wav = path.join(directory, "long.wav");
      execFileSync(ffmpeg, [
        "-y",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=180",
        wav,
      ]);
      const job = await local("mp3", wav);
      await page.waitForFunction(
        async (id) =>
          (
            (await chrome.storage.local.get("lensMediaJobs")).lensMediaJobs ||
            []
          ).find((j) => j.id === id)?.progress?.phase === "FFmpeg 编码运行",
        job.id,
        { timeout: 30000, polling: 10 },
      );
      await request("mediaAction", { jobId: job.id, action: "cancel" });
      const cancelled = await waitJob(job.id, "cancelled");
      assert.ok(!cancelled.downloadId);
      await waitIdle();
      const names = await page.evaluate(async () => {
        const input = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("lens-input-v1");
        const names = [];
        for await (const key of input.keys()) names.push(key);
        return names;
      });
      assert.deepEqual(names, []);
      fs.unlinkSync(wav);
    },
  );
  await check(
    "Media longer than one hour is rejected without silently truncating an output",
    async () => {
      const wav = path.join(directory, "over-hour.wav");
      const samples = 3601,
        bytes = Buffer.alloc(44 + samples * 2);
      bytes.write("RIFF", 0);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      bytes.write("WAVEfmt ", 8);
      bytes.writeUInt32LE(16, 16);
      bytes.writeUInt16LE(1, 20);
      bytes.writeUInt16LE(1, 22);
      bytes.writeUInt32LE(1, 24);
      bytes.writeUInt32LE(2, 28);
      bytes.writeUInt16LE(2, 32);
      bytes.writeUInt16LE(16, 34);
      bytes.write("data", 36);
      bytes.writeUInt32LE(samples * 2, 40);
      fs.writeFileSync(wav, bytes);
      const job = await local("mp3", wav),
        failed = await waitJob(job.id, "failed");
      assert.match(failed.error, /最长 1 小时/);
      assert.ok(!failed.downloadId);
      await waitIdle();
      fs.unlinkSync(wav);
    },
  );
};
