// User-selected design: disk-backed downloads and encoded-packet remuxing;
// no decoding, encoding, native helper, remote code, or whole-file ArrayBuffer.
import {
  Input,
  BlobSource,
  MP4,
  Output,
  Mp4OutputFormat,
  StreamTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from "./vendor-mediabunny.js";

export const LIMITS = Object.freeze({
  chunk: 2 * 1024 * 1024,
  sourceBytes: 2 * 1024 ** 3,
  seconds: 3600,
  packets: 500000,
  packetBytes: 16 * 1024 ** 2,
  fragmentBytes: 64 * 1024 ** 2,
});

// Probe the first range, then fetch at most four bounded ranges in parallel.
// Writes use explicit positions, so completion order never changes file order.
// Each response owns at most one 2 MiB buffer; a server ignoring the initial
// Range still falls back to one streamed request with bounded disk writes.
export async function downloadTrack(
  url,
  writable,
  {
    signal,
    budget,
    progress,
    fetcher = fetch,
    onSize = async () => {},
    timeoutMs = 60000,
    concurrency = 4,
  },
) {
  let total = null,
    downloaded = 0,
    validator = null;
  const stopped = new AbortController(),
    downloadSignal = AbortSignal.any([signal, stopped.signal]);
  let workers = [];
  async function readRange(start, end, initial = false) {
    const timeout = new AbortController(),
      requestSignal = AbortSignal.any([downloadSignal, timeout.signal]);
    let timer, response;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => timeout.abort(new Error("媒体下载超过 60 秒没有进展，请重试")),
        timeoutMs,
      );
    };
    try {
      requestSignal.throwIfAborted();
      touch();
      response = await fetcher(url, {
        headers: {
          Range: `bytes=${start}-${end}`,
          ...(validator ? { "If-Range": validator } : {}),
        },
        credentials: "omit",
        redirect: "error",
        signal: requestSignal,
      });
      touch();
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("content-range") || "",
      );
      if (response.status !== 206 && !(response.status === 200 && initial))
        throw new Error(`媒体下载失败 HTTP ${response.status}`);
      if (
        response.status === 206 &&
        (!range ||
          Number(range[1]) !== start ||
          Number(range[2]) < start ||
          Number(range[2]) > end ||
          !Number.isSafeInteger(Number(range[3])) ||
          Number(range[3]) <= Number(range[2]) ||
          (!initial && Number(range[2]) !== Math.min(end, total - 1)))
      )
        throw new Error("CDN 返回了无效的字节范围");
      const expected = range
        ? Number(range[2]) - start + 1
        : Number(response.headers.get("content-length")) || null;
      const declared = range ? Number(range[3]) : expected;
      if (
        declared !== null &&
        (!Number.isSafeInteger(declared) ||
          declared <= 0 ||
          (!initial && total !== declared))
      )
        throw new Error("媒体大小在下载期间发生变化");
      const etag = response.headers.get("etag");
      if (initial) {
        total = declared;
        // A strong ETag prevents mixing versions when the CDN supplies one.
        if (etag && !etag.startsWith("W/")) validator = etag;
        if (total && total + budget.bytes > LIMITS.sourceBytes)
          throw new Error(
            "所选音视频合计超过 2 GiB，请改选较低码率或下载原始轨道",
          );
        if (total) await onSize(total + budget.bytes);
      } else if (validator && etag && validator !== etag)
        throw new Error("媒体内容在下载期间发生变化，请重新下载");
      requestSignal.throwIfAborted();
      if (!response.body) throw new Error("媒体响应没有数据");
      const reader = response.body.getReader(),
        buffer = new Uint8Array(
          Math.min(expected || LIMITS.chunk, LIMITS.chunk),
        );
      let received = 0,
        filled = 0,
        written = 0;
      async function flush() {
        if (!filled) return;
        requestSignal.throwIfAborted();
        budget.bytes += filled;
        if (budget.bytes > LIMITS.sourceBytes)
          throw new Error("音视频合计超过 2 GiB 上限");
        await writable.write({
          type: "write",
          position: start + written,
          data: buffer.subarray(0, filled),
        });
        requestSignal.throwIfAborted();
        touch();
        downloaded += filled;
        written += filled;
        filled = 0;
        progress({
          bytes: budget.bytes,
          trackBytes: downloaded,
          trackTotal: total,
        });
      }
      try {
        while (true) {
          requestSignal.throwIfAborted();
          const { done, value } = await reader.read();
          touch();
          if (done) break;
          received += value.byteLength;
          if (expected !== null && received > expected)
            throw new Error("媒体响应超过声明范围");
          for (let offset = 0; offset < value.byteLength;) {
            const size = Math.min(
              buffer.length - filled,
              value.byteLength - offset,
            );
            buffer.set(value.subarray(offset, offset + size), filled);
            filled += size;
            offset += size;
            if (filled === buffer.length) await flush();
          }
        }
        if (!received || (expected !== null && received !== expected))
          throw new Error("媒体响应不完整，请重新下载");
        await flush();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { received, ranged: response.status === 206 };
    } finally {
      clearTimeout(timer);
      timeout.abort();
      await response?.body?.cancel().catch(() => {});
    }
  }
  try {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
      throw new Error("媒体下载并发须为 1–4");
    const first = await readRange(0, LIMITS.chunk - 1, true);
    if (first.ranged) {
      let next = first.received;
      const worker = async () => {
        while (next < total) {
          downloadSignal.throwIfAborted();
          const start = next;
          next += LIMITS.chunk;
          await readRange(start, Math.min(start + LIMITS.chunk - 1, total - 1));
        }
      };
      workers = Array.from(
        {
          length: Math.min(
            concurrency,
            Math.ceil((total - next) / LIMITS.chunk),
          ),
        },
        worker,
      );
      await Promise.all(workers);
    }
    downloadSignal.throwIfAborted();
    if (total !== null && downloaded !== total)
      throw new Error("媒体响应不完整，请重新下载");
    await writable.close();
    return downloaded;
  } catch (error) {
    stopped.abort(error);
    // Wait until siblings have stopped before aborting/cleaning the disk file.
    await Promise.allSettled(workers);
    await writable.abort().catch(() => {});
    throw error;
  } finally {
    stopped.abort();
  }
}

export async function remuxFiles(
  videoFile,
  audioFile,
  writable,
  { signal, progress },
) {
  const inputs = [videoFile, audioFile].map(
    (file) =>
      new Input({
        source: new BlobSource(file, {
          maxCacheSize: LIMITS.chunk,
          useStreamReader: false,
        }),
        formats: [MP4],
      }),
  );
  let output,
    pendingBytes = 0,
    bytes = 0,
    packets = 0;
  const abort = () => {
    for (const input of inputs) input.dispose();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const tracks = [
      await inputs[0].getPrimaryVideoTrack(),
      await inputs[1].getPrimaryAudioTrack(),
    ];
    if (tracks.some((track) => !track))
      throw new Error("文件中缺少视频或音频轨道");
    const codecs = await Promise.all(tracks.map((track) => track.getCodec()));
    if (!["avc", "hevc", "av1"].includes(codecs[0]) || codecs[1] !== "aac")
      throw new Error(
        "插件内 MP4 支持 AVC / HEVC / AV1 视频和 AAC 音频，请改选轨道；其他编码可保存原始轨道",
      );
    const configs = await Promise.all(
      tracks.map((track) => track.getDecoderConfig()),
    );
    if (configs.some((config) => !config))
      throw new Error("媒体编码配置不可用或受到加密保护");
    const sources = [
      new EncodedVideoPacketSource(codecs[0]),
      new EncodedAudioPacketSource(codecs[1]),
    ];
    output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "fragmented",
        minimumFragmentDuration: 2,
        onMoof: () => {
          pendingBytes = 0;
        },
      }),
      target: new StreamTarget(
        new WritableStream({
          async write(chunk) {
            signal.throwIfAborted();
            if (
              chunk.position + chunk.data.byteLength >
              LIMITS.sourceBytes + 64 * 1024 ** 2
            )
              throw new Error("输出文件超过安全大小上限");
            for (
              let start = 0;
              start < chunk.data.byteLength;
              start += LIMITS.chunk
            )
              await writable.write({
                type: "write",
                position: chunk.position + start,
                data: chunk.data.subarray(start, start + LIMITS.chunk),
              });
            bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
          },
        }),
      ),
    });
    output.addVideoTrack(sources[0], {
      rotation: await tracks[0].getRotation(),
    });
    output.addAudioTrack(sources[1]);
    await output.start();
    const sinks = tracks.map((track) => new EncodedPacketSink(track));
    // Read metadata first so an oversized sample is rejected before allocating
    // its encoded payload. Both traversals stay in decode order, including B frames.
    const previous = [null, null];
    const next = await Promise.all(
      sinks.map((sink) => sink.getFirstPacket({ metadataOnly: true })),
    );
    if (next.some((packet) => !packet))
      throw new Error("媒体轨道没有可封装的数据包");
    while (next.some(Boolean)) {
      signal.throwIfAborted();
      const index = !next[0]
        ? 1
        : !next[1]
          ? 0
          : next[0].timestamp <= next[1].timestamp
            ? 0
            : 1;
      const metadata = next[index];
      if (
        ++packets > LIMITS.packets ||
        metadata.byteLength > LIMITS.packetBytes ||
        !Number.isFinite(metadata.timestamp) ||
        !Number.isFinite(metadata.duration) ||
        metadata.duration < 0 ||
        metadata.timestamp < -10 ||
        metadata.timestamp + metadata.duration > LIMITS.seconds + 1
      )
        throw new Error("媒体超过 1 小时、50 万数据包或单包 16 MiB 的支持范围");
      pendingBytes += metadata.byteLength;
      if (pendingBytes > LIMITS.fragmentBytes)
        throw new Error(
          "关键帧间隔过大，单片段超过 64 MiB；请改选轨道或下载原始轨道",
        );
      const packet = previous[index]
        ? await sinks[index].getNextPacket(previous[index])
        : await sinks[index].getFirstPacket();
      await sources[index].add(packet, { decoderConfig: configs[index] });
      progress({
        processedMs: Math.max(0, packet.timestamp * 1000),
        bytes,
        packets,
      });
      previous[index] = metadata;
      next[index] = await sinks[index].getNextPacket(packet, {
        metadataOnly: true,
      });
      if (!next[index]) sources[index].close();
    }
    await output.finalize();
    signal.throwIfAborted();
    await writable.close();
    return { bytes, packets, codecs };
  } catch (error) {
    await output?.cancel().catch(() => {});
    await writable.abort().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    for (const input of inputs) input.dispose();
  }
}
