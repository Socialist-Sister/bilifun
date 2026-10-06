// Copy only our narrow, fixed-source build. Never fetch code at runtime.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const build = path.resolve(
  process.argv[2] || path.join(root, "artifacts/wasm-build"),
);
const extension = path.join(root, "extension");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sha256 = {},
  sizes = {};
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  const bytes = fs.readFileSync(path.join(build, "dist", name));
  if (
    name.endsWith(".wasm") &&
    !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  )
    throw new Error("Invalid WASM");
  fs.writeFileSync(path.join(extension, name), bytes);
  sha256[name] = hash(bytes);
  sizes[name] = bytes.length;
}
const sources = {};
for (const name of [
  "ffmpeg-5.1.8.tar.xz",
  "bindings-0.12.10.tar.gz",
  "lame-source.tar.gz",
])
  sources[name] = hash(
    fs.readFileSync(path.join(root, "third-party/ffmpeg", name)),
  );
fs.writeFileSync(
  path.join(extension, "ffmpeg-vendor.json"),
  JSON.stringify(
    {
      ffmpeg: "5.1.8",
      bindings: "0.12.10",
      lame: "3.100",
      lameCommit: "2badea1974ae36cb8312afe99cff1e6b3b5decee",
      emscripten: "3.1.40",
      license: "LGPL-2.1-or-later; bindings MIT",
      sha256,
      sizes,
      sources,
    },
    null,
    2,
  ) + "\n",
);
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const licenses = [
  ["FFmpeg LGPL-2.1-or-later", "ffmpeg-5.1.8/COPYING.LGPLv2.1"],
  ["LAME LGPL", "lame-2badea1974ae36cb8312afe99cff1e6b3b5decee/COPYING"],
  ["ffmpeg.wasm bindings MIT", "ffmpeg.wasm-0.12.10/LICENSE"],
];
fs.writeFileSync(
  path.join(extension, "ffmpeg-license.html"),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>内置精简 FFmpeg · 许可与来源</title><link rel="stylesheet" href="ui.css"><main><h1>内置精简 FFmpeg WASM</h1><p>FFmpeg 5.1.8 / LAME 3.100 / ffmpeg.wasm 0.12.10 bindings / Emscripten 3.1.40。独立扩展代码为 MIT，此组合核心为 LGPL-2.1-or-later。没有链接 GPL 视频编码器。只保留合并和音频转码，禁用网络。</p><p>对应源归档及编译步骤随源码 ZIP 提供，位于 third-party/ffmpeg 与 scripts/build-ffmpeg.sh。可替换本地核心并重新加载扩展。</p><p>上游：<a href="https://ffmpeg.org/releases/ffmpeg-5.1.8.tar.xz">FFmpeg 5.1.8</a> · <a href="https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10">绑定及修改后的 CLI 源码</a> · <a href="https://github.com/ffmpegwasm/lame/tree/2badea1974ae36cb8312afe99cff1e6b3b5decee">LAME 固定源码</a></p><pre>' +
    escape(JSON.stringify({ sha256, sizes, sources }, null, 2)) +
    "</pre>" +
    licenses
      .map(
        ([label, file]) =>
          `<h2>${label}</h2><pre>${escape(fs.readFileSync(path.join(build, file), "utf8"))}</pre>`,
      )
      .join("") +
    "</main></html>\n",
);
console.log(JSON.stringify({ sha256, sizes, sources }, null, 2));
