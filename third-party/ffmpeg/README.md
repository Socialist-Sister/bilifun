# 内置精简 FFmpeg WASM

对应源代码随源码 ZIP 提供；运行包不包含原生可执行文件。项目独立代码 MIT；FFmpeg / LAME 组合核心 LGPL-2.1-or-later；ffmpeg.wasm 绑定 MIT，仓库里的 FFmpeg CLI 修改继续遵循其原 LGPL。运行包 ffmpeg-license.html 提供完整许可和哈希。

固定输入：

- ffmpeg-5.1.8.tar.xz：https://ffmpeg.org/releases/ffmpeg-5.1.8.tar.xz
- bindings-0.12.10.tar.gz：https://github.com/ffmpegwasm/ffmpeg.wasm/archive/refs/tags/v0.12.10.tar.gz （含 src/bind、修改后的 src/fftools）
- lame-source.tar.gz：https://github.com/ffmpegwasm/lame/archive/2badea1974ae36cb8312afe99cff1e6b3b5decee.tar.gz
- Emscripten SDK 3.1.40：https://github.com/emscripten-core/emsdk/tree/3.1.40

归档 SHA-256 与生成核心 SHA-256 在 extension/ffmpeg-vendor.json 中，打包校验会核对。上游归档保持原始字节，源码没有隐藏补丁；CLI 的 wasm 替换、进度和超时钩子来自固定绑定归档。

构建环境需要 Emscripten 3.1.40、sh、make。用户安装扩展不需要这些工具。将三个源归档解压到同一 build 目录（目录名分别 ffmpeg-5.1.8、ffmpeg.wasm-0.12.10、lame-2badea1974ae36cb8312afe99cff1e6b3b5decee），激活 SDK 后：

```sh
source /path/to/emsdk/emsdk_env.sh
bash scripts/build-ffmpeg.sh /absolute/build
node scripts/vendor-ffmpeg.cjs /absolute/build
npm run build
```

Windows 使用便携 MSYS2 的 bash / make，Python、Node 和编译器来自 SDK，不修改系统注册项。Emscripten 3.1.40 的 emnm shell 入口包含未引用的 `dirname $0`；带空格目录构建时将其修正为 `dirname "$0"`。这是工具入口的路径引用修正，不是媒体引擎源码修改。

脚本禁用 network、视频编码器、硬件加速、线程、SDL 和不需要的格式。保留 MP4 / Matroska / MP3 / AAC / WAV 读取，MP4 / Matroska / MP3 写出，AAC / MP3 / PCM 解码，AAC 和 LAME 编码，以及必要的解析器、音频过滤器和重采样。单线程、允许内存增长至 1 GiB、禁用 JS 动态执行；专用 Worker 每任务重新创建。

高级转换源文件合计 128 MiB，输出小于 192 MiB，最多 1 小时、10 分钟运行；这些是本项目边界。WORKERFS 挂载源 File，MEMFS 有界输出；禁止来自网页的任意 CLI。普通 MP4 继续用 Mediabunny 快速磁盘流程。
