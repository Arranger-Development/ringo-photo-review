# Ringo 照片编配听评

GitHub Pages 提供网页。常开主机保存原图、候选、MP3、评分和日志，并调用百炼。在线评审使用受邀邮箱和独立口令。所有成员可查看共享素材，每位成员只能看到自己的评分，管理员可以导出全库评分和导入离线评分。

## 启动常开主机

主机需要 Python 3.11 或以上、`jsonschema`、FluidSynth、FFmpeg 和 FFprobe。使用与原工作台相同的 GeneralUser GS 音色库。可复制现有工作台数据目录到主机，任一时刻只运行一个写入该数据目录的工作台进程。

以下命令在独立仓库的源码分支根目录运行。若在主软件工作区测试，同样可以从仓库根目录运行。

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install 'jsonschema>=4,<5'
python scripts/serve_shared_photo_review.py --data-dir /path/to/photo-workbench --invite owner@example.com --admin
python scripts/serve_shared_photo_review.py --data-dir /path/to/photo-workbench --invite reviewer@example.com
```

邀请命令在终端显示一次随机口令。把口令分别交给对应成员。重复运行同一邮箱的邀请命令会轮换口令并撤销旧会话。管理员再次轮换时带上 `--admin`。邀请信息与库文件保存在本机数据目录。

在主机的服务环境配置 `DASHSCOPE_API_KEY`、`RINGO_API_ORIGIN=https://api.example.com`。可选设置 `DASHSCOPE_BASE_URL`、`DASHSCOPE_MODEL` 和 `RINGO_SOUNDFONT`。默认从数据目录加载 `GeneralUser-GS.sf2`。配置好环境后启动：

```sh
python scripts/serve_shared_photo_review.py --data-dir /path/to/photo-workbench --port 8767
```

将公网 HTTPS 接入转发到 `http://127.0.0.1:8767`，例如使用 Cloudflare Tunnel、ngrok 或其他 HTTPS 反向代理。API 仅监听回环接口。代理可以保留与 `RINGO_API_ORIGIN` 一致的 Host，也可以转发为 `127.0.0.1:8767`。后台使用自己的受邀登录，HTTPS 接入可独立更换。

## 发布网页

将 `standalone/photo-review/` 的静态文件发布到 Pages 发布分支根目录。将 `online-config.js` 中的 `apiOrigin` 设置为主机的公网 HTTPS 地址。默认允许的网页来源为 `https://arranger-development.github.io`，本地联调可通过 `RINGO_FRONTEND_ORIGIN` 指定另一个来源。运行目录、百炼密钥和邀请文件位于主机。Pages 发布分支根目录只存放静态网页。

在本机预览离线界面时，从网页目录运行 `python3 -m http.server 8766 --bind 127.0.0.1`。

## 分享和回传

完整听评 ZIP 包含 `photo-workbench/photos/<photoId>/`，每张照片含 `state.json`、`listen.json`、`intent.json`、`arrangements.json`、原图及对应 MP3。离线听评支持既有 4–6 套 ZIP 和新的 7–8 套 ZIP。下载自己的 JSONL 后可发给管理员合并。
