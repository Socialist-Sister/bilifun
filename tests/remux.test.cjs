const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const core = import("../extension/remux-core.js");
function disk(filename) {
  const fd = fs.openSync(filename, "w");
  let closed = false,
    maxWrite = 0,
    position = 0;
  return {
    get maxWrite() {
      return maxWrite;
    },
    async write(chunk) {
      const data = chunk.data || chunk;
      maxWrite = Math.max(maxWrite, data.byteLength);
      fs.writeSync(fd, data, 0, data.byteLength, chunk.position ?? position);
      position += data.byteLength;
    },
    async close() {
      if (!closed) fs.closeSync(fd);
      closed = true;
    },
    async abort() {
      if (!closed) fs.closeSync(fd);
      closed = true;
    },
  };
}
test("Range requests and disk writes are bounded; byte-exact source > 2 MiB", async () => {
  const { downloadTrack, LIMITS } = await core,
    bytes = crypto.randomBytes(LIMITS.chunk * 2 + 127),
    ranges = [];
  const file = path.join(root, "artifacts/range-source.bin"),
    writable = disk(file);
  await downloadTrack("https://test.bilivideo.com/track", writable, {
    signal: new AbortController().signal,
    budget: { bytes: 0 },
    progress() {},
    fetcher: async (url, options) => {
      ranges.push(options.headers.Range);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      const [, start, end] = /bytes=(\d+)-(\d+)/
        .exec(options.headers.Range)
        .map(Number);
      const last = Math.min(end, bytes.length - 1);
      return new Response(bytes.subarray(start, last + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${last}/${bytes.length}` },
      });
    },
  });
  assert.equal(ranges.length, 3);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.ok(writable.maxWrite <= LIMITS.chunk);
});
test("Reject invalid/truncated ranges, HTTP failure and >2GiB declaration", async () => {
  const { downloadTrack } = await core;
  for (const response of [
    new Response("x", { status: 403 }),
    new Response("x", {
      status: 206,
      headers: { "Content-Range": "bytes 1-1/2" },
    }),
    new Response("x", {
      status: 206,
      headers: { "Content-Range": "bytes 0-9/10" },
    }),
    new Response("x", {
      status: 206,
      headers: { "Content-Range": "bytes 0-0/3000000000" },
    }),
  ]) {
    let aborted = false;
    await assert.rejects(
      downloadTrack(
        "https://test.bilivideo.com/track",
        {
          async write() {},
          async close() {},
          async abort() {
            aborted = true;
          },
        },
        {
          signal: new AbortController().signal,
          budget: { bytes: 0 },
          progress() {},
          fetcher: async () => response,
        },
      ),
    );
    assert.ok(aborted);
  }
});
test("Parallel ranges complete out of order, coalesce small reads and preserve exact disk bytes with bounded concurrency", async () => {
  const { downloadTrack, LIMITS } = await core,
    bytes = crypto.randomBytes(LIMITS.chunk * 7 + 131),
    filename = path.join(root, "artifacts/parallel-source.bin"),
    writable = disk(filename),
    positions = [],
    progress = [];
  let active = 0,
    peak = 0;
  const write = writable.write;
  writable.write = async (chunk) => {
    positions.push(chunk.position);
    await write(chunk);
  };
  const result = await downloadTrack(
    "https://test.bilivideo.com/track",
    writable,
    {
      signal: new AbortController().signal,
      budget: { bytes: 0 },
      progress: (value) => progress.push(value.trackBytes),
      fetcher: async (url, options) => {
        const [, start, end] = /bytes=(\d+)-(\d+)/
            .exec(options.headers.Range)
            .map(Number),
          last = Math.min(end, bytes.length - 1);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) =>
          setTimeout(resolve, start === LIMITS.chunk ? 70 : 5),
        );
        active--;
        let offset = start;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (offset > last) return controller.close();
              const next = Math.min(offset + 65536, last + 1);
              controller.enqueue(bytes.subarray(offset, next));
              offset = next;
            },
          }),
          {
            status: 206,
            headers: {
              "Content-Range": `bytes ${start}-${last}/${bytes.length}`,
            },
          },
        );
      },
    },
  );
  assert.equal(result, bytes.length);
  assert.equal(peak, 4);
  assert.equal(
    positions.length,
    8,
    "64KiB reads are combined into one write per bounded range",
  );
  assert.ok(
    positions.indexOf(LIMITS.chunk) > positions.indexOf(LIMITS.chunk * 2),
  );
  assert.ok(
    progress.every((value, index) => !index || value > progress[index - 1]),
  );
  assert.ok(writable.maxWrite <= LIMITS.chunk);
  assert.deepEqual(fs.readFileSync(filename), bytes);
});
test("A parallel failure aborts and drains sibling requests before disk cleanup; changed media is rejected", async () => {
  const { downloadTrack, LIMITS } = await core;
  for (const failure of ["http", "size", "etag", "timeout", "cancel"]) {
    let active = 0,
      cleanup = false;
    const controller = new AbortController();
    await assert.rejects(
      downloadTrack(
        "https://test.bilivideo.com/track",
        {
          async write() {},
          async close() {
            assert.fail("failed parallel download must not close successfully");
          },
          async abort() {
            assert.equal(active, 0);
            cleanup = true;
          },
        },
        {
          signal: controller.signal,
          budget: { bytes: 0 },
          timeoutMs: 30,
          progress() {},
          fetcher: async (url, { headers, signal }) => {
            const [, start, end] = /bytes=(\d+)-(\d+)/
              .exec(headers.Range)
              .map(Number);
            if (!start)
              return new Response(new Uint8Array(LIMITS.chunk), {
                status: 206,
                headers: {
                  "Content-Range": `bytes 0-${LIMITS.chunk - 1}/${LIMITS.chunk * 5}`,
                  ETag: '"v1"',
                },
              });
            assert.equal(headers["If-Range"], '"v1"');
            if (
              start === LIMITS.chunk &&
              !["timeout", "cancel"].includes(failure)
            ) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return new Response("x", {
                status: failure === "http" ? 403 : 206,
                headers: {
                  "Content-Range": `bytes ${start}-${end}/${LIMITS.chunk * (failure === "size" ? 6 : 5)}`,
                  ETag: failure === "etag" ? '"v2"' : '"v1"',
                },
              });
            }
            active++;
            if (start === LIMITS.chunk && failure === "cancel")
              setTimeout(() => controller.abort(), 5);
            return new Promise((resolve, reject) => {
              const abort = () => {
                active--;
                reject(signal.reason);
              };
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          },
        },
      ),
    );
    assert.ok(cleanup);
  }
});
test("Cancellation and inactivity timeout abort a stalled fetch and writable", async () => {
  const { downloadTrack } = await core;
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let aborted = false;
    const promise = downloadTrack(
      "https://test.bilivideo.com/track",
      {
        async write() {},
        async close() {},
        async abort() {
          aborted = true;
        },
      },
      {
        signal: controller.signal,
        timeoutMs: 30,
        budget: { bytes: 0 },
        progress() {},
        fetcher: (url, { signal }) =>
          new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      },
    );
    if (cancel) controller.abort();
    await assert.rejects(promise);
    assert.ok(aborted);
  }
});
test("A server ignoring Range is streamed to disk with bounded writes", async () => {
  const { downloadTrack, LIMITS } = await core,
    bytes = crypto.randomBytes(LIMITS.chunk + 12),
    writable = disk(path.join(root, "artifacts/range-fallback.bin"));
  await downloadTrack("https://test.bilivideo.com/track", writable, {
    signal: new AbortController().signal,
    budget: { bytes: 0 },
    progress() {},
    fetcher: async () => new Response(bytes),
  });
  assert.ok(writable.maxWrite <= LIMITS.chunk);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "artifacts/range-fallback.bin")),
    bytes,
  );
});
test("Actual AVC B-frame + AAC remux preserves every packet and A/V timestamps and decodes", async () => {
  const python = process.env.TEST_PYTHON_EXECUTABLE;
  assert.ok(python, "Set TEST_PYTHON_EXECUTABLE for the real decode test");
  const ffmpeg = execFileSync(
    python,
    [
      "-c",
      "import sys;sys.path.insert(0,'artifacts/test-deps');import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())",
    ],
    { cwd: root },
  )
    .toString()
    .trim();
  const directory = path.join(root, "artifacts/browser-remux-fixtures");
  fs.mkdirSync(directory, { recursive: true });
  const video = path.join(directory, "video.m4s"),
    audio = path.join(directory, "audio.m4s"),
    out = path.join(directory, "output.mp4");
  for (const [filename, args] of [
    [
      video,
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30",
        "-t",
        "12",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "16",
        "-g",
        "60",
        "-bf",
        "3",
        "-output_ts_offset",
        "0.6",
      ],
    ],
    [
      audio,
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "12",
        "-vn",
        "-c:a",
        "aac",
        "-output_ts_offset",
        "0.73",
      ],
    ],
  ])
    execFileSync(ffmpeg, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...args,
      "-f",
      "mp4",
      "-movflags",
      "frag_keyframe+empty_moov",
      filename,
    ]);
  const { remuxFiles, LIMITS } = await core;
  assert.ok(fs.statSync(video).size > LIMITS.chunk);
  const writable = disk(out);
  const result = await remuxFiles(
    new Blob([fs.readFileSync(video)]),
    new Blob([fs.readFileSync(audio)]),
    writable,
    { signal: new AbortController().signal, progress() {} },
  );
  assert.deepEqual(result.codecs, ["avc", "aac"]);
  assert.ok(writable.maxWrite <= LIMITS.chunk);
  execFileSync(ffmpeg, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    out,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
  const { Input, BlobSource, MP4, EncodedPacketSink } =
    await import("../extension/vendor-mediabunny.js");
  async function packets(filename, kind) {
    const input = new Input({
      source: new BlobSource(new Blob([fs.readFileSync(filename)])),
      formats: [MP4],
    });
    const track =
      kind === "video"
        ? await input.getPrimaryVideoTrack()
        : await input.getPrimaryAudioTrack();
    const result = [];
    for await (const packet of new EncodedPacketSink(track).packets())
      result.push({
        hash: crypto.createHash("sha256").update(packet.data).digest("hex"),
        timestamp: packet.timestamp,
        duration: packet.duration,
      });
    input.dispose();
    return result;
  }
  for (const [filename, kind] of [
    [video, "video"],
    [audio, "audio"],
  ]) {
    const before = await packets(filename, kind),
      after = await packets(out, kind);
    assert.equal(before.length, after.length);
    for (let i = 0; i < before.length; i++) {
      assert.equal(before[i].hash, after[i].hash);
      assert.ok(
        Math.abs(before[i].timestamp - after[i].timestamp) < 0.0001,
        `${kind} timestamp ${i}: ${before[i].timestamp} vs ${after[i].timestamp}`,
      );
      assert.ok(Math.abs(before[i].duration - after[i].duration) < 0.0001);
    }
    if (kind === "video")
      assert.ok(
        before.some((p, i) => i && p.timestamp < before[i - 1].timestamp),
        "Fixture contains actual reordered B frames",
      );
  }
  fs.writeFileSync(
    path.join(directory, "report.json"),
    JSON.stringify(
      {
        result,
        videoBytes: fs.statSync(video).size,
        maxDiskWrite: writable.maxWrite,
        decoded: true,
        encodedPacketsByteIdentical: true,
        timestampsPreserved: true,
      },
      null,
      2,
    ),
  );
});
