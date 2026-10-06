importScripts("core.js", "danmaku.js");
onmessage = (event) => {
  try {
    postMessage({
      ok: true,
      result: LensDanmaku.filter(event.data.rows, event.data.rules),
    });
  } catch (error) {
    postMessage({ ok: false, error: error.message });
  }
};
