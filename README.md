# Ringo 照片编配听评

工作台由 GitHub Pages 静态发布。使用 Chrome 打开网页即可。浏览器调用百炼、合成音频、保存本机记录和处理 ZIP。

## 单图验证

填入百炼 Key，选一张 JPEG 或 PNG，再选 6–8 套编配。Key 当前页面有效，优先使用百炼临时 Key。展开接入设置可以填写 Key 所在地域的官方 Base URL 和模型 ID。一次生成记录保存原图、音乐意图、编配、盲听索引、原始回包和每次调用的计时日志。接通百炼的费用按该 Key 的账户记。关闭页面后的待生成记录可手动继续。

「下载完整编配 ZIP」导出所有本机生成记录。包内有 `ringo.json` 和 `photos/<photoId>/`，原图、结构化结果、原始回包、映射和日志按照片组织。试听 MP3 是浏览器缓存，对方在听评时可重新生成。记录与缓存保存在当前 Chrome 浏览器配置文件。可用 ZIP 保留成果。

## 批量听评

导入一个编配 ZIP，填固定的评审名。浏览器逐张合成。第一张准备好后就可以查看图片、试听和填写评分。重开同一网页可继续缓存和评分。关闭网页会暂停合成。此前包含原图和 MP3 的听评 ZIP 仍可导入。导出听评结果为 ZIP，含 `ringo.json` 和 `ratings.jsonl`。将该包交给生成者，通过「导入听评结果 ZIP」合并，同一照片和评审保留最新匹配候选的一份。可单独导出汇总评分 ZIP。

## 发布与依赖

Pages 发布来源为 `release/photo-review-pages` 分支根目录。站点资源全部用相对路径加载，运行时需要 Chrome 支持 WebAssembly、Web Worker、IndexedDB 和 Compression Streams。

- [GeneralUser GS](https://www.schristiancollins.com/generaluser.php) 音色库 SHA-256 为 `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe`，许可及署名见 `vendor/GeneralUser-GS-LICENSE.txt`。
- [js-synthesizer v1.13.0](https://www.npmjs.com/package/js-synthesizer/v/1.13.0) 提供 FluidSynth 2.4.6 的浏览器构建。源码和编译方法见 [js-synthesizer](https://github.com/jet2jet/js-synthesizer) 与 [FluidSynth Emscripten 构建](https://github.com/jet2jet/fluidsynth-emscripten)。许可证在 `vendor/`。
- [ffmpeg.wasm 单线程 core 0.12.10](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10) 用于响度检测与 MP3 编码。构建脚本、完整对应源码和依赖入口见 [ffmpeg.wasm v0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10)、[FFmpeg 源码](https://github.com/FFmpeg/FFmpeg) 和 `vendor/ffmpeg-COPYING.GPLv2`。
- [fflate 0.8.3](https://www.npmjs.com/package/fflate/v/0.8.3) 写 ZIP。[Ajv 8.20.0](https://www.npmjs.com/package/ajv/v/8.20.0) 生成静态 Schema 校验器 `vendor/validators.js`。
