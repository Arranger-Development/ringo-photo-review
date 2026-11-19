# Ringo 照片编配听评

打开页面后导入本机工作台的**完整听评库 ZIP**。ZIP 中的照片和 MP3 在浏览器读取。选择评审名后，打开照片、盲听 A–F 并评分。评分保存在当前浏览器，可以导出该评审的 `ratings.jsonl` 发回汇总。

完整 ZIP 的结构为 `photo-workbench/photos/<photoId>/`，每张照片含 `state.json`、`listen.json`、`photo` 和试听 MP3。使用近期的 Chrome、Edge、Safari 或 Firefox 打开页面。

在本机预览时，从本目录运行 `python3 -m http.server 8766 --bind 127.0.0.1`，然后打开 `http://127.0.0.1:8766/`。
