# BiliFun

搜索、下载、弹幕与字幕，一站搞定。

BiliFun 是面向桌面 Chrome / Edge 的开源 B 站扩展，以独立搜索页为主要入口，提供视频下载、音频处理、弹幕过滤及字幕导出。安装插件即可使用，无需另装本地助手。

**当前版本：0.5.1 测试版。** 重点支持普通投稿视频。项目与哔哩哔哩官方无隶属关系，尚未上架扩展商店。

## 功能

- **独立搜索**：统一卡片、按 BV 号去重、分批读取结果、展示标题与已有简介 / 标签，支持已读管理和手动排除。结果来自 B 站搜索接口，不保证消除服务器端的个性化。
- **视频下载**：自动读取当前视频和分 P，选择实际可用清晰度与音轨，下载带声音的 MP4，支持批量分 P、进度、取消、重试及打开成品所在文件夹。
- **音频与转换**：下载 M4A，内置精简 FFmpeg WASM 实现 MKV 合并、MP3 / AAC 转码，以及已有文件的合并与音频提取。
- **弹幕**：按分 P 读取当前可访问的弹幕，预览、搜索，按关键词、正则、类型等过滤，导出 JSON / XML / ASS；支持本地文件过滤和批量分 P 导出。
- **字幕与工具**：导出已有字幕 JSON / SRT / WebVTT、封面和视频信息，管理带分 P 的时间戳书签。
- **视频页悬浮面板**：悬浮球可拖动并记住位置，功能直接在侧面展开；网页全屏与原生全屏时隐藏。

原搜索页自动筛选、跨页补位及播放器增强属于**实验功能，默认关闭**。字符串规则可能误判中文连续查询和隐含主题，建议优先使用独立搜索页。

## 安装

1. 从 [Releases](https://github.com/Socialist-Sister/bilifun/releases) 下载 `bilifun-版本号.zip`，并解压到固定文件夹。也可以下载本仓库源码，使用其中的 `extension` 文件夹。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择**直接包含 `manifest.json`** 的文件夹。源码请选择 `extension`，不要选择项目根目录。
4. 刷新已打开的 B 站页面。点击扩展图标进入独立搜索，或在视频页点击悬浮球展开工具。

第一次使用时按提示授权。数据接口权限用于搜索和视频信息，下载及媒体域名权限在开始下载时申请。清晰度、字幕和可用音轨受账号、会员权限及接口返回值影响。

更新时替换原文件夹内容，在扩展管理页点击“重新加载”，再刷新 B 站。BiliFun 保留旧版 Bili Search Lens 的内部配置键，现有设置无需重建。

## 下载范围

| 流程 | 当前限制 |
| --- | --- |
| 普通 / 批量 MP4 | 未加密 DASH，音视频合计不超过 2 GiB，最长 1 小时；最多 30 个活动任务 |
| 高级 MKV / 音频转换 / 已有文件处理 | 输入合计不超过 128 MiB，输出小于 192 MiB，最长 1 小时、最多处理 10 分钟 |
| 编码 | 普通 MP4 优先 H.264 / AAC；高级功能不提供视频重编码、字幕烧录或任意 FFmpeg 命令 |

普通 MP4 通过最多 4 路有界分块下载和磁盘缓存重封装。收起面板或关闭工具页后已创建任务继续运行；浏览器完全退出后不自动续传。需要足够的浏览器私有缓存空间，任务结束时清理缓存。已有文件处理通过文件选择器读取，不自动读取下载记录中的绝对路径。

番剧、课程、直播、互动视频、历史弹幕、官方客户端和移动浏览器暂不作为支持范围；AI 语义搜索、语音转写及摘要尚未提供。具体支持状态与验证边界见 [能力矩阵](CAPABILITIES.md) 和 [验证记录](VERIFICATION.md)。请只保存有权使用的内容，并遵守平台条款与作者授权。

## 隐私

无遥测、远程脚本或默认上传。配置、书签和任务记录保存在扩展本地；媒体与本地文件在浏览器内处理，不上传转换服务。请求使用当前浏览器的 B 站会话，扩展不读取或导出 Cookie。完整权限、缓存及可选设置同步说明见 [PRIVACY.md](PRIVACY.md)。

## 开发

源码可直接加载，无需构建。开发检查需要 Node.js 22+、Python 3.10+：

```sh
npm ci
npm test
npm run check
npm run format:check
npx playwright install chromium
npm run test:browser
npm run build
python scripts/verify-release.py
```

真实 MV3 验证另有 `test:search`、`test:extension`、`test:panel`、`test:remux` 和 `test:convert`。`TEST_BROWSER_EXECUTABLE` 可指定 Edge / Chrome，`TEST_PYTHON_EXECUTABLE` 指定测试 Python；媒体测试使用独立解码器校验成品，详见 [VERIFICATION.md](VERIFICATION.md)。这些工具仅开发需要，安装插件无需额外组件。

打包生成 `artifacts/bilifun-版本号.zip`、`bilifun-版本号-source.zip` 和 `SHA256SUMS`，固定顺序与时间戳。测试与临时构建资料保存在 `artifacts/`，不纳入仓库或发布包。

欢迎通过 [Issues](https://github.com/Socialist-Sister/bilifun/issues) 提交问题。提供浏览器 / 扩展版本、复现步骤和状态文字；分享诊断内容前请检查个人信息。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，路线图见 [TODO.md](TODO.md)，更新见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

项目独立代码采用 [MIT](LICENSE)。Mediabunny 使用 MPL-2.0，精简 FFmpeg / LAME 使用 LGPL-2.1+，WASM 绑定另含 MIT。第三方完整声明随扩展提供；固定版本、对应源归档与构建步骤见 [third-party/ffmpeg/README.md](third-party/ffmpeg/README.md)。生成测试媒体为 CC0。
