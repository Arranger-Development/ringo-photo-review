"""Serve the local photo-to-arrangement validation page on loopback."""

import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
from time import perf_counter
from urllib.parse import urlsplit

from jsonschema import ValidationError, validate

from photo_workbench import PhotoWorkbench
from run_photo_arrangement import (
    ArrangementRejections,
    DEFAULT_CATALOG,
    SPECS,
    generate_photo_arrangements,
    generate_photo_intent,
    read_json,
    validate_intent,
)


PAGE = SPECS.parents[1] / "mockups" / "photo-arrangement-check.html"
WORKBENCH_PAGE = PAGE.with_name("photo-arrangement-workbench.html")
WORKBENCH_DIR = SPECS.parents[1] / "output" / "photo-workbench"
MAX_PHOTO_BYTES = 10 * 1024 * 1024
IMAGE_PREFIXES = {"image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG\r\n\x1a\n"}
ID_PATTERN = r"[0-9a-f]{32}"


def dashscope_url(value):
    url = urlsplit(value.strip())
    official_host = re.fullmatch(
        r"(?:dashscope(?:-intl|-us)?|[a-z0-9-]+\.[a-z0-9-]+\.maas)\.aliyuncs\.com",
        url.netloc.lower(),
    )
    if url.scheme != "https" or not official_host or url.query or url.fragment:
        raise ValueError("请输入阿里云百炼的 HTTPS 接入地址。")
    path = url.path.rstrip("/").removesuffix("/chat/completions")
    if path != "/compatible-mode/v1":
        raise ValueError("接入地址应包含 /compatible-mode/v1。")
    return f"https://{url.netloc.lower()}{path}"


def api_key_from(data):
    api_key = data["apiKey"].strip()
    if not re.fullmatch(r"[!-~]{1,1024}", api_key):
        raise ValueError("请输入有效的 API Key。")
    return api_key


def model_from(data):
    model = data["model"].strip()
    if not re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", model):
        raise ValueError("请输入有效的模型 ID。")
    return model


def photo_from(data):
    mime_type = data["mimeType"]
    prefix = IMAGE_PREFIXES.get(mime_type)
    photo = base64.b64decode(data["photo"], validate=True)
    if not prefix or not photo.startswith(prefix) or len(photo) > MAX_PHOTO_BYTES:
        raise ValueError("请上传 10 MB 以内的 JPEG 或 PNG 照片。")
    return photo, mime_type


class PhotoArrangementHandler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def send_body(self, status, content_type, body, headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if hasattr(self, "post_started"):
            total_ms = (perf_counter() - self.post_started) * 1000
            upstream_ms = self.timing.get("upstream_ms")
            header = f"local;dur={total_ms:.1f}" if upstream_ms is None else (
                f"bailian;dur={upstream_ms:.1f}, local;dur={max(0, total_ms - upstream_ms):.1f}"
            )
            self.send_header("Server-Timing", header)
            if self.timing.get("trimmed_notes"):
                self.send_header("X-Ringo-Trimmed-Notes", str(self.timing["trimmed_notes"]))
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, value):
        self.send_body(status, "application/json; charset=utf-8", json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def local_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def send_audio(self, path):
        audio = path.read_bytes()
        header = self.headers.get("Range")
        if not header:
            self.send_body(200, "audio/mpeg", audio, [("Accept-Ranges", "bytes")])
            return
        match = re.fullmatch(r"bytes=(\d{0,12})-(\d{0,12})", header)
        if match and (match[1] or match[2]):
            if match[1]:
                start = int(match[1])
                end = min(int(match[2]) if match[2] else len(audio) - 1, len(audio) - 1)
            else:
                start, end = max(0, len(audio) - int(match[2])), len(audio) - 1
            if start <= end:
                self.send_body(206, "audio/mpeg", audio[start:end + 1],
                               [("Accept-Ranges", "bytes"), ("Content-Range", f"bytes {start}-{end}/{len(audio)}")])
                return
        self.send_body(416, "audio/mpeg", b"", [("Content-Range", f"bytes */{len(audio)}")])

    def workbench_get(self):
        workbench = self.server.workbench
        if self.path == "/api/workbench/jobs":
            self.send_json(200, workbench.listing())
            return
        export = re.fullmatch(rf"/api/workbench/export/({ID_PATTERN})", self.path)
        job = re.fullmatch(rf"/api/workbench/jobs/({ID_PATTERN})/(listen|photo|thumbnail|[A-F]\.mp3)", self.path)
        try:
            if self.path == "/api/workbench/export" or export:
                batch_id = export[1] if export else None
                filename = f"ringo-{batch_id[:8]}.zip" if batch_id else "ringo-review-library.zip"
                self.send_body(200, "application/zip", workbench.export(batch_id),
                               [("Content-Disposition", f'attachment; filename="{filename}"')])
            elif job:
                job_id, asset = job.groups()
                info, folder = workbench.view(job_id), workbench.folder(job_id)
                if asset == "listen":
                    self.send_json(200, workbench.listening(job_id))
                elif asset == "photo":
                    self.send_body(200, info["mimeType"], (folder / asset).read_bytes())
                elif asset == "thumbnail":
                    self.send_body(200, "image/jpeg", workbench.thumbnail(job_id))
                elif info["phase"] == "ready" and (folder / asset).is_file():
                    self.send_audio(folder / asset)
                else:
                    self.send_json(404, {"error": "试听不存在。"})
            else:
                self.send_json(404, {"error": "页面不存在。"})
        except (KeyError, FileNotFoundError):
            self.send_json(404, {"error": "找不到这张照片。"})
        except ValueError as error:
            self.send_json(422, {"error": str(error)})

    def do_GET(self):
        if not self.local_host():
            self.send_json(403, {"error": "请打开启动时打印的 127.0.0.1 地址。"})
        elif self.path == "/":
            self.send_body(200, "text/html; charset=utf-8", PAGE.read_bytes())
        elif urlsplit(self.path).path == "/workbench":
            self.send_body(200, "text/html; charset=utf-8", WORKBENCH_PAGE.read_bytes())
        elif self.path == "/api/example":
            self.send_json(200, read_json(SPECS / "photo-arrangements.example.json"))
        elif self.path.startswith("/api/workbench/"):
            self.workbench_get()
        else:
            self.send_json(404, {"error": "页面不存在。"})

    def do_POST(self):
        self.post_started = perf_counter()
        self.timing = {}
        if not self.local_host() or self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
            self.send_json(403, {"error": "请从本地验证页发起请求。"})
            return
        is_workbench = self.path.startswith("/api/workbench/")
        if not is_workbench and self.path not in {"/api/intent", "/api/arrangements"}:
            self.send_json(404, {"error": "接口不存在。"})
            return
        api_key = ""
        try:
            if self.headers.get_content_type() != "application/json":
                raise ValueError("请求必须使用 JSON。")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 14 * 1024 * 1024:
                raise ValueError("请求过大或为空。照片上限 10 MB。")
            data = json.loads(self.rfile.read(size))
            if is_workbench:
                self.workbench_post(data)
                return
            api_key = api_key_from(data)
            api_url = dashscope_url(data["apiUrl"])
            model = model_from(data)
            if self.path == "/api/intent":
                _, mime_type = photo_from(data)
                with self.server.workbench.operation("qwen_call", stage="intent", model=model, source="single") as timing:
                    self.timing = timing
                    result = generate_photo_intent(api_url, api_key, model, mime_type, data["photo"],
                                                   fast_image=data.get("fastImage") is True, timing=timing)
            else:
                count = data["count"]
                if type(count) is not int or not 4 <= count <= 8:
                    raise ValueError("候选数量须为 4 到 8。")
                intent = data["intent"]
                validate(intent, read_json(SPECS / "photo-music-intent.schema.json"))
                validate_intent(intent)
                catalog = read_json(DEFAULT_CATALOG)
                previous = data.get("previous")
                keep_positions = data.get("keepPositions", [])
                if not isinstance(keep_positions, list) or any(type(position) is not int or not 1 <= position <= count for position in keep_positions):
                    raise ValueError("保留候选的编号有误。")
                stage = "repairing" if previous is not None else "arranging"
                with self.server.workbench.operation("qwen_call", stage=stage, model=model, source="single",
                                                     candidateCount=count, retainedCandidates=keep_positions) as timing:
                    self.timing = timing
                    result = generate_photo_arrangements(api_url, api_key, model, intent, catalog, count,
                                                         previous=previous, keep_positions=keep_positions, timing=timing)
        except ArrangementRejections as error:
            self.send_json(422, {"error": str(error), "recovery": {"result": error.result, "issues": error.issues}})
        except ValidationError as error:
            self.send_json(422, {"error": f"JSON 校验失败（{error.json_path}）。请重试此阶段。"})
        except ValueError as error:
            message = str(error)
            self.send_json(422, {"error": message.replace(api_key, "[密钥]") if api_key else message})
        except (KeyError, TypeError, AttributeError, IndexError):
            self.send_json(400, {"error": "请求字段或上游返回格式有误。"})
        except OSError:
            self.send_json(502, {"error": "连接百炼失败或超时。请检查网络和 Base URL 后重试。"})
        else:
            self.send_json(200, result)


    def workbench_post(self, data):
        workbench = self.server.workbench
        if self.path in {"/api/workbench/jobs", "/api/workbench/example"}:
            job_id, batch_id = data["id"], data["batchId"]
            if not re.fullmatch(ID_PATTERN, job_id) or not re.fullmatch(ID_PATTERN, batch_id):
                raise ValueError("任务编号不正确。")
            if self.path.endswith("/example"):
                result = workbench.example(job_id, batch_id)
            else:
                name, count = data["name"].strip(), data["count"]
                if not 0 < len(name) <= 255 or type(count) is not int or not 4 <= count <= 6:
                    raise ValueError("需要提供照片名称和 4–6 套候选数。")
                photo, mime_type = photo_from(data)
                result = workbench.submit(job_id, batch_id, name, photo, mime_type, count,
                                          api_key_from(data), dashscope_url(data["apiUrl"]), model_from(data),
                                          upload_ms=round((perf_counter() - self.post_started) * 1000, 1))
            self.send_json(202, result)
            return
        match = re.fullmatch(rf"/api/workbench/jobs/({ID_PATTERN})/(rate|retry)", self.path)
        if not match:
            self.send_json(404, {"error": "接口不存在。"})
        elif match[2] == "rate":
            self.send_json(200, workbench.rate(match[1], data))
        else:
            key = "" if workbench.view(match[1]).get("example") else api_key_from(data)
            self.send_json(202, workbench.retry(match[1], key))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=WORKBENCH_DIR)
    parser.add_argument("--soundfont", type=Path, default=os.environ.get("RINGO_SOUNDFONT"))
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), PhotoArrangementHandler) as server:
        server.workbench = PhotoWorkbench(args.data_dir, args.soundfont or args.data_dir / "GeneralUser-GS.sf2")
        print(f"Local: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
