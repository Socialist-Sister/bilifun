# 贡献指南

欢迎按 [TODO](TODO.md) 的功能编号提交小范围改动。发布前请对照 [能力矩阵](CAPABILITIES.md)，区分实现完成、本地样本通过与真实站点验证。问题与改进建议可提交到 [GitHub Issues](https://github.com/Socialist-Sister/bilifun/issues)。

## 开发

扩展运行无打包步骤：从扩展管理页加载 `extension/`。开发测试使用 Node.js 22+、Python 3.10+ 和 Chromium。安装依赖使用 `npm ci`，按 README 运行规则、静态、浏览器、实际 MV3 和内置 WASM 转换测试。浏览器测试目录和下载文件位于 artifacts，不能改用用户日常浏览器资料。

新增页面选择器优先改 adapter；新增接口先提供脱敏响应样例及错误分级；纯规则保持无 DOM / 网络依赖。触及取消、生命周期或下载状态时添加对应回归；文案及低风险样式修改只做必要检查，不添加实现镜像测试。

更改运行逻辑必须随扩展打包，不引入远程执行脚本。消息只开放窄操作，验证发送者、字段、域名和任务状态。记录和反馈不含 Cookie、签名 URL、个人本地路径或私人笔记。接口风控应停止并说明，不能通过自动无限重试规避验证。

## 验证和发布

Mock 用于可重复的错误、取消和结构测试；不能用 Mock 宣称真实接口可用。网络探针需显式运行，使用独立未登录配置，不自动写进日常测试或 CI；服务器可能改变，不把失败当成测试依赖安装故障。

`scripts/build.py` 生成运行包、源码包和校验和。源码 ZIP 的白名单排除了用户资料和测试配置。对同一源树运行两次应得到相同 SHA-256。发布前检查 ZIP 根部 manifest、版本、权限、CSP、变更日志与已知问题。公开仓库、商店提交和发布说明需后续实际发布流程。

## 许可证与借鉴

本项目独立编写的规则、WBI 签名、Protobuf 读取器、ZIP 和 ASS 转换器采用 MIT。协议资料是接口研究来源，未复制 Bilibili-Evolved 等项目实现代码，不把其许可证套用到本项目。两秒合成媒体样例为 CC0-1.0（见 tests/fixtures/README.md）。

浏览器内 MP4 重封装使用随扩展本地打包的 Mediabunny 1.61.0（MPL-2.0）。它有独立许可证，不被本项目 MIT 许可证覆盖；第三方声明、许可证及对应源码获取方式随包提供。普通合并直接处理已有编码数据，不调用 FFmpeg、WebAssembly 或远程执行代码。更新 vendor 时需使用固定依赖、保留许可声明，并重新验证生成文件和生命周期。

package-lock.json 锁定的开发依赖：

| 工具 / 类型 | 许可证 |
| --- | --- |
| Playwright / playwright-core | Apache-2.0 |
| TypeScript 及各平台编译器包 | Apache-2.0 |
| Prettier | MIT |
| @types/chrome、node、filesystem、filewriter、har-format；undici-types | MIT |
| Mediabunny（同时是打包的运行依赖） | MPL-2.0 |

node_modules 不进入发布包，重新安装依赖时须遵守其随包许可证。媒体验证临时使用 imageio-ffmpeg 0.6.0（Python 包 BSD-2-Clause）提供的测试程序，位于 artifacts/test-deps，不进入任何发布 ZIP。FFmpeg 二进制的构建及许可证独立于 Python 包；测试原生程序不进入发布包；插件分发精简 FFmpeg WASM，固定来源、对应源归档与完整许可证见 third-party/ffmpeg。

引入新库、字体、WASM、图标或借鉴实现前，记录来源、版本、许可证及必要声明，不以“已有 MIT 文件”代替核对。

