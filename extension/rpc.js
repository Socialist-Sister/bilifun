(function (root) {
  "use strict";
  // The page deadline also covers a worker or message channel that never replies.
  function createClient(send) {
    async function request(message, { timeout = 25000, signal } = {}) {
      return new Promise((resolve, reject) => {
        let settled = false,
          timer;
        const finish = (error, result, cancel = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (cancel && message.token) {
            try {
              Promise.resolve(
                send({ op: "cancelRequest", token: message.token }),
              ).catch(() => {});
            } catch {}
          }
          if (error) reject(error);
          else resolve(result);
        };
        const abort = () =>
          finish(new DOMException("读取已取消", "AbortError"), undefined, true);
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          const error = new Error(
            `读取超过 ${Math.ceil(timeout / 1000)} 秒，已停止等待。请检查网络或代理后重试；必要时重载扩展并刷新当前页面。`,
          );
          error.name = "TimeoutError";
          finish(error, undefined, true);
        }, timeout);
        Promise.resolve()
          .then(() => (settled ? undefined : send(message)))
          .then((response) => {
            if (settled) return;
            if (!response?.ok)
              finish(
                new Error(
                  response?.error || "后台未响应，请重载扩展后刷新当前页面",
                ),
              );
            else finish(null, response.result);
          })
          .catch((error) => finish(error));
      });
    }
    return Object.freeze({ request });
  }
  root.LensRpc = Object.freeze({
    createClient,
    ...createClient((message) => root.chrome.runtime.sendMessage(message)),
  });
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.LensRpc;
})(globalThis);
