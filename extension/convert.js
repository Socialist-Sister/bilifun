export const CONVERT_LIMIT = 128 * 1024 ** 2;
export function convertFiles(
  files,
  format,
  writable,
  { signal, progress = () => {} } = {},
) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./convert-worker.js", import.meta.url));
    let settled = false;
    const finish = async (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      try {
        if (error) {
          await writable.abort();
          reject(error);
        } else {
          await writable.write(bytes);
          await writable.close();
          resolve({ bytes: bytes.length, codecs: [] });
        }
      } catch (cause) {
        await writable.abort().catch(() => {});
        reject(cause);
      }
    };
    const abort = () =>
      finish(signal.reason || new DOMException("任务已取消", "AbortError"));
    const timer = setTimeout(
      () => finish(new Error("高级转换超过 10 分钟，请缩短源文件")),
      10 * 60 * 1000,
    );
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () =>
      finish(new Error("内置转换引擎启动失败或内存不足，请减少源文件大小"));
    worker.onmessage = ({ data }) => {
      if (data.progress) progress(data.progress);
      else if (data.error) finish(new Error(data.error));
      else if (data.bytes instanceof Uint8Array) finish(null, data.bytes);
    };
    worker.postMessage({ files, format, merge: files.length === 2 });
  });
}
