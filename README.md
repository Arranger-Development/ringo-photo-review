# Ringo 照片编配听评

工作台由 GitHub Pages 静态发布。使用 Chrome 打开网页即可。浏览器调用百炼、合成音频、保存本机记录和处理 ZIP。

## 单图验证

填入百炼 Key，选一张 JPEG 或 PNG，再选 6–8 套编配。Key 当前页面有效，优先使用百炼临时 Key。展开接入设置可以填写 Key 所在地域的官方 Base URL 和模型 ID。一次生成记录保存原图、音乐意图、编配、盲听索引和诊断日志。接通百炼的费用按该 Key 的账户记。关闭页面后的待生成记录可手动继续。

「下载完整编配 ZIP」导出所有本机生成记录。包内有 `ringo.json` 和 `photos/<photoId>/`，原图、结构化结果、原始回包、映射和日志按照片组织。试听 MP3 是浏览器缓存，对方在听评时可重新生成。记录与缓存保存在当前 Chrome 浏览器配置文件。可用 ZIP 保留成果。

## 批量听评

导入一个编配 ZIP，填固定的评审名。浏览器逐张合成。第一张准备好后就可以查看图片、试听和填写评分。重开同一网页可继续缓存和评分。关闭网页会暂停合成。此前包含原图和 MP3 的听评 ZIP 仍可导入。导出听评结果为 ZIP，含 `ringo.json` 和 `ratings.jsonl`。将该包交给生成者，通过「导入听评结果 ZIP」合并，同一照片和评审保留最新匹配候选的一份。可单独导出汇总评分 ZIP。

## 诊断归档

在单图页使用「导入百炼审计（JSON 或 JSONL）」，支持控制台复制的单条记录、记录数组、官方 CLI 的 `list` 输出及每行一条记录的 JSONL。导入后显示匹配、重复、未匹配及格式错误的数量。按服务端 Request ID 精确关联，浏览器等待耗时和百炼服务端耗时各自保留。相同审计记录重复导入只存一次。未匹配的记录仍可通过「下载完整编配 ZIP」保存。 [百炼审计日志](https://help.aliyun.com/zh/model-studio/model-telemetry#审计日志) · [CLI 日志查询](https://help.aliyun.com/zh/model-studio/cli/monitor-log-alert)

两种 ZIP 的 `ringo.json` 通过 `diagnostics.indexPath` 指向 `logs/index.json`。索引里的 `files` 列出每个日志文件及条数，`bailian` 汇总匹配与缺失。以 `eventId` 去重，同一个操作的多条浏览器或渲染日志用 `operationId` 聚合。时间采用 UTC ISO 格式，耗时采用毫秒。存在时可用 `photoId`、`callId`、`candidateId`、`packId` 或服务端 `providerRequestId` 关联。

- `logs/browser/events.jsonl` 收录生成、重试、中断、ZIP 操作、播放及评分事件。
- `logs/qwen/calls.jsonl` 收录 HTTP、网络、校验和补生成结果。每条通过 `requestPath`、`rawResponsePath` 定位保留的请求配置及回包。请求里的图片用原图路径表示。
- `logs/render/events.jsonl` 收录排队、引擎加载、缓存命中、候选合成、编码、响度和错误。
- `logs/bailian/audit.jsonl` 收录整理后的审计字段，`calls` 指向匹配的浏览器请求，`rawPaths` 指向脱敏后的原始审计记录。
- 编配 ZIP 同时保留每张照片原有的 `events.jsonl`。听评结果 ZIP 的工作流和渲染日志以当前听评包为限。导出结束与失败状态保存在浏览器，纳入下一次导出。

访问凭据在日志写入前脱敏。历史记录按已有数据导出，缺失的时间或请求标识留空。把 ZIP 下载到本地可长期保留诊断记录。

## 发布与依赖

Pages 发布来源为 `release/photo-review-pages` 分支根目录。站点资源全部用相对路径加载，运行时需要 Chrome 支持 WebAssembly、Web Worker、IndexedDB 和 Compression Streams。

- [GeneralUser GS](https://www.schristiancollins.com/generaluser.php) 音色库 SHA-256 为 `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe`，许可及署名见 `vendor/GeneralUser-GS-LICENSE.txt`。
- [js-synthesizer v1.13.0](https://www.npmjs.com/package/js-synthesizer/v/1.13.0) 提供 FluidSynth 2.4.6 的浏览器构建。源码和编译方法见 [js-synthesizer](https://github.com/jet2jet/js-synthesizer) 与 [FluidSynth Emscripten 构建](https://github.com/jet2jet/fluidsynth-emscripten)。许可证在 `vendor/`。
- [ffmpeg.wasm 单线程 core 0.12.10](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10) 用于响度检测与 MP3 编码。构建脚本、完整对应源码和依赖入口见 [ffmpeg.wasm v0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10)、[FFmpeg 源码](https://github.com/FFmpeg/FFmpeg) 和 `vendor/ffmpeg-COPYING.GPLv2`。
- [fflate 0.8.3](https://www.npmjs.com/package/fflate/v/0.8.3) 写 ZIP。[Ajv 8.20.0](https://www.npmjs.com/package/ajv/v/8.20.0) 生成静态 Schema 校验器 `vendor/validators.js`。
