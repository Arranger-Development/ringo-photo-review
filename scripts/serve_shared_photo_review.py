"""Serve the shared review API behind an HTTPS reverse proxy."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from hashlib import sha256
from hmac import compare_digest
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
from secrets import token_urlsafe
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from threading import RLock
from time import monotonic
from urllib.parse import urlsplit

from photo_workbench import PhotoWorkbench, persist
from serve_photo_arrangement import ID_PATTERN, PhotoArrangementHandler, api_key_from, dashscope_url, model_from, photo_from

PAGE_ORIGIN = "https://arranger-development.github.io"
EMAIL = re.compile(r"[^\s@]{1,64}@[^\s@]{1,189}", re.ASCII)
CODE = re.compile(r"[A-Za-z0-9_-]{43}")
SESSION_SECONDS = 8 * 3600
DOWNLOAD_SECONDS = 10 * 60
JOB_ASSET = re.compile(rf"/api/jobs/({ID_PATTERN})/(listen|photo|thumbnail|[A-H]\.mp3)")
JOB_WRITE = re.compile(rf"/api/jobs/({ID_PATTERN})/(rate|retry)")


class RequestError(ValueError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def digest(value):
    return sha256(value.encode()).hexdigest()


def account_email(value):
    if not isinstance(value, str) or not EMAIL.fullmatch(value.strip()):
        raise ValueError("请输入有效的邮箱。")
    return value.strip().lower()


def http_origin(value):
    url = urlsplit(value)
    if (url.scheme != "https" and not (url.scheme == "http" and url.hostname == "127.0.0.1")) or (
        not url.hostname or url.username is not None or url.path not in ("", "/") or url.query or url.fragment
    ):
        raise ValueError("请配置 HTTPS 域名，本机联调可使用 127.0.0.1。")
    return f"{url.scheme}://{url.netloc}"


class MemberSessions:
    def __init__(self, path):
        self.path = path
        self.lock = RLock()
        self.sessions = {}

    def accounts(self):
        return json.loads(self.path.read_text(encoding="utf-8")) if self.path.is_file() else {}

    def login(self, data):
        email = account_email(data.get("email"))
        code = data.get("code")
        account = self.accounts().get(email)
        if not isinstance(code, str) or not CODE.fullmatch(code) or not account or not compare_digest(
            digest(code), account["codeHash"]
        ):
            raise RequestError(401, "邮箱或邀请口令不正确。")
        token = token_urlsafe(32)
        with self.lock:
            self.sessions = {key: item for key, item in self.sessions.items() if item[2] > monotonic()}
            self.sessions[digest(token)] = (email, account["codeHash"], monotonic() + SESSION_SECONDS)
        return {"token": token, "email": email, "admin": bool(account["admin"])}

    def require(self, authorization):
        if not authorization.startswith("Bearer ") or not CODE.fullmatch(authorization[7:]):
            raise RequestError(401, "请先登录工作台。")
        key = digest(authorization[7:])
        with self.lock:
            item = self.sessions.get(key)
            if not item or item[2] <= monotonic():
                self.sessions.pop(key, None)
                raise RequestError(401, "登录已过期，请重新登录。")
        email, old_hash, _ = item
        account = self.accounts().get(email)
        if not account or not compare_digest(old_hash, account["codeHash"]):
            raise RequestError(401, "邀请已变更，请重新登录。")
        return email, bool(account["admin"])

    def logout(self, authorization):
        with self.lock:
            self.sessions.pop(digest(authorization[7:]), None)


class BundleDownloads:
    def __init__(self, workbench, directory):
        self.workbench = workbench
        self.directory = directory
        self.lock = RLock()
        self.entries = {}
        self.worker = ThreadPoolExecutor(max_workers=1)

    def expire(self):
        now = monotonic()
        for key, entry in list(self.entries.items()):
            if entry["status"] != "packing" and entry["expires"] < now:
                (self.directory / key).unlink(missing_ok=True)
                del self.entries[key]

    def start(self, email):
        with self.lock:
            self.expire()
            for key, entry in self.entries.items():
                if entry["email"] == email and entry["status"] == "packing":
                    return key
            key = token_urlsafe(32)
            self.entries[key] = {"email": email, "status": "packing"}
            self.worker.submit(self.pack, key)
            return key

    def pack(self, key):
        try:
            self.workbench.full_export(self.directory / key)
        except Exception as error:
            (self.directory / key).unlink(missing_ok=True)
            message = str(error) if isinstance(error, ValueError) else "完整听评库打包失败。"
            fields = {"status": "failed", "error": message}
        else:
            fields = {"status": "ready"}
        with self.lock:
            self.entries[key].update(expires=monotonic() + DOWNLOAD_SECONDS, **fields)

    def status(self, email, key):
        with self.lock:
            self.expire()
            entry = self.entries.get(key)
            if not entry or email != entry["email"]:
                raise RequestError(404, "下载任务不存在或已过期。")
            return {field: entry[field] for field in ("status", "error") if field in entry}

    def take(self, key):
        with self.lock:
            self.expire()
            if self.entries.get(key, {}).get("status") != "ready":
                raise RequestError(404, "下载链接不可用，请重新打包。")
            self.entries.pop(key)
            return self.directory / key


def rater_id(email):
    return email if len(email) <= 48 else "member-" + digest(email)[:32]


class SharedReviewHandler(PhotoArrangementHandler):
    def send_response(self, code, message=None):
        super().send_response(code, message)
        if self.headers.get("Origin") == self.server.frontend_origin:
            self.send_header("Access-Control-Allow-Origin", self.server.frontend_origin)
        self.send_header("Vary", "Origin")

    def origin(self):
        if self.headers.get("Host") not in {self.server.public_host, f"127.0.0.1:{self.server.server_port}"}:
            raise RequestError(403, "请求地址不在工作台配置中。")

    def do_OPTIONS(self):
        self.dispatch(self.preflight)

    def preflight(self):
        if self.headers.get("Origin") != self.server.frontend_origin or not self.path.startswith("/api/"):
            raise RequestError(403, "请求来源不在工作台配置中。")
        self.send_body(204, "text/plain", b"", [
            ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
            ("Access-Control-Allow-Headers", "Authorization, Content-Type, Range"),
            ("Access-Control-Max-Age", "300"),
        ])

    def dispatch(self, action):
        try:
            self.origin()
            action()
        except RequestError as error:
            self.send_json(error.status, {"error": str(error)})
        except (KeyError, FileNotFoundError):
            self.send_json(404, {"error": "找不到指定的照片或文件。"})
        except (TypeError, AttributeError, IndexError):
            self.send_json(400, {"error": "请求数据格式有误。"})
        except ValueError as error:
            self.send_json(422, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.dispatch(self.read_endpoint)

    def do_POST(self):
        self.dispatch(self.write_endpoint)

    def read_json_body(self, limit):
        size = int(self.headers.get("Content-Length", "0"))
        if self.headers.get_content_type() != "application/json" or not 0 < size <= limit:
            raise RequestError(400, "请求格式有误或文件超出大小限制。")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise RequestError(400, "请求必须是 JSON 对象。")
        return data

    def member(self):
        if self.headers.get("Origin") != self.server.frontend_origin:
            raise RequestError(403, "请从 GitHub Pages 工作台访问。")
        return self.server.members.require(self.headers.get("Authorization", ""))

    def available_job(self, job_id):
        job = self.server.workbench.view(job_id)
        if job.get("example"):
            raise RequestError(404, "找不到指定的照片。")
        return job

    def public_job(self, job, email, admin):
        fields = ("id", "name", "count", "createdAt", "phase", "error", "photoSha256")
        public = {key: job.get(key) for key in fields}
        public["rated"] = rater_id(email) in job["raters"]
        public["canRetry"] = job["phase"] == "failed" and (admin or job.get("owner") == email)
        return public

    def read_endpoint(self):
        path = urlsplit(self.path).path
        download = re.fullmatch(r"/download/([A-Za-z0-9_-]{43})", path)
        if download:
            self.download_bundle(download[1])
            return
        email, admin = self.member()
        workbench = self.server.workbench
        if path == "/api/session":
            self.send_json(200, {"email": email, "admin": admin})
        elif path == "/api/jobs":
            self.send_json(200, [self.public_job(job, email, admin) for job in workbench.listing()
                                 if not job.get("example")])
        elif path in {"/api/ratings/mine", "/api/ratings/all"}:
            if path.endswith("/all") and not admin:
                raise RequestError(403, "只有管理员可以导出汇总评分。")
            reviewer = rater_id(email) if path.endswith("/mine") else None
            self.send_body(200, "application/x-ndjson; charset=utf-8", self.rating_export(reviewer))
        elif match := re.fullmatch(r"/api/downloads/([A-Za-z0-9_-]{43})", path):
            self.send_json(200, self.server.downloads.status(email, match[1]))
        elif match := JOB_ASSET.fullmatch(path):
            self.job_asset(*match.groups(), email)
        else:
            raise RequestError(404, "接口不存在。")

    def job_asset(self, job_id, asset, email):
        job = self.available_job(job_id)
        workbench = self.server.workbench
        folder = workbench.folder(job_id)
        if asset == "photo":
            self.send_body(200, job["mimeType"], (folder / asset).read_bytes())
        elif asset == "thumbnail":
            self.send_body(200, "image/jpeg", workbench.thumbnail(job_id))
        elif job["phase"] != "ready":
            raise RequestError(404, "这张照片的试听还未完成。")
        elif asset == "listen":
            data = workbench.listening(job_id)
            data["ratings"] = [item for item in data["ratings"] if item["raterId"] == rater_id(email)]
            self.send_json(200, data)
        else:
            self.send_audio(folder / asset)

    def write_endpoint(self):
        path = urlsplit(self.path).path
        if path == "/api/login":
            if self.headers.get("Origin") != self.server.frontend_origin:
                raise RequestError(403, "请从 GitHub Pages 工作台登录。")
            session = self.server.members.login(self.read_json_body(4096))
            self.send_json(200, {**session, "raterId": rater_id(session["email"])})
            return
        email, admin = self.member()
        workbench = self.server.workbench
        if path == "/api/logout":
            self.server.members.logout(self.headers["Authorization"])
            self.send_json(200, {})
        elif path == "/api/jobs":
            data = self.read_json_body(14 * 1024 * 1024)
            job_id = data["id"]
            name = data["name"].strip()
            count = data.get("count", 6)
            if not re.fullmatch(ID_PATTERN, job_id) or not 0 < len(name) <= 255 or type(count) is not int or not 6 <= count <= 8:
                raise ValueError("请提供照片名称，候选数量须为 6 到 8 套。")
            photo, mime = photo_from(data)
            job = workbench.submit(job_id, job_id, name, photo, mime, count, self.server.api_key,
                                   self.server.api_url, self.server.model, owner=email)
            self.send_json(202, self.public_job(job, email, admin))
        elif path == "/api/downloads":
            self.send_json(202, {"id": self.server.downloads.start(email)})
        elif path == "/api/ratings/import":
            if not admin:
                raise RequestError(403, "只有管理员可以导入离线评分。")
            data = self.read_json_body(4 * 1024 * 1024)
            self.send_json(200, self.rating_import(data["jsonl"]))
        elif match := JOB_WRITE.fullmatch(path):
            job_id, operation = match.groups()
            job = self.available_job(job_id)
            if operation == "retry":
                if not admin and job.get("owner") != email:
                    raise RequestError(403, "可重试自己上传的照片。")
                result = workbench.retry(job_id, self.server.api_key)
                self.send_json(202, self.public_job(result, email, admin))
            else:
                data = self.read_json_body(32 * 1024)
                data["raterId"] = rater_id(email)
                self.send_json(200, workbench.rate(job_id, data))
        else:
            raise RequestError(404, "接口不存在。")

    def rating_export(self, reviewer):
        workbench = self.server.workbench
        records = []
        for job in workbench.listing():
            if job.get("example") or job["phase"] != "ready":
                continue
            records.extend(record for record in workbench.listening(job["id"])["ratings"]
                           if reviewer is None or record["raterId"] == reviewer)
        return "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records).encode("utf-8")

    def rating_import(self, content):
        if not isinstance(content, str):
            raise ValueError("请选择评分 JSONL 文件。")
        workbench = self.server.workbench
        result = {"added": 0, "skipped": 0, "errors": []}
        for number, line in enumerate(content.splitlines(), 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                job_id = record["photoId"]
                if not re.fullmatch(ID_PATTERN, job_id):
                    raise ValueError("照片编号无效。")
                job = self.available_job(job_id)
                if record["photoSha256"] != job["photoSha256"] or record["displayOrder"] != [
                    candidate["id"] for candidate in workbench.listening(job_id)["candidates"]
                ]:
                    raise ValueError("照片或试听顺序和总库不一致。")
                version = record["schemaVersion"]
                stamp = datetime.fromisoformat(record["ratedAt"])
                if version not in (1, 2) or (version == 2 and "usable" not in record) or stamp.utcoffset() is None:
                    raise ValueError("评分版本或时间无效。")
                saved = workbench.rate(job_id, record, imported_at=stamp.isoformat())
                result["added" if saved else "skipped"] += 1
            except (ValueError, KeyError, TypeError, AttributeError) as error:
                result["skipped"] += 1
                if len(result["errors"]) < 10:
                    message = str(error) if isinstance(error, RequestError) else "找不到匹配照片或评分格式不符。"
                    result["errors"].append({"line": number, "error": message})
        return result

    def download_bundle(self, key):
        path = self.server.downloads.take(key)
        try:
            with path.open("rb") as stream:
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(path.stat().st_size))
                self.send_header("Content-Disposition", 'attachment; filename="ringo-complete-review-library.zip"')
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                copyfileobj(stream, self.wfile, 256 * 1024)
        finally:
            path.unlink(missing_ok=True)


def invite(path, email, admin):
    email = account_email(email)
    members = MemberSessions(path)
    accounts = members.accounts()
    code = token_urlsafe(32)
    accounts[email] = {"codeHash": digest(code), "admin": admin}
    path.parent.mkdir(parents=True, exist_ok=True)
    persist(path, accounts)
    path.chmod(0o600)
    print(f"{email}\n{code}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--soundfont", type=Path, default=os.getenv("RINGO_SOUNDFONT"))
    parser.add_argument("--invite")
    parser.add_argument("--admin", action="store_true")
    args = parser.parse_args()
    accounts = args.data_dir / "shared-accounts.json"
    if args.invite:
        invite(accounts, args.invite, args.admin)
        return
    if not accounts.is_file():
        parser.error("请先用 --invite 建立至少一位受邀成员。")
    api_key = api_key_from({"apiKey": os.getenv("DASHSCOPE_API_KEY", "")})
    api_url = dashscope_url(os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"))
    model = model_from({"model": os.getenv("DASHSCOPE_MODEL", "qwen3.8-flash")})
    api_origin = http_origin(os.getenv("RINGO_API_ORIGIN", f"http://127.0.0.1:{args.port}"))
    frontend = http_origin(os.getenv("RINGO_FRONTEND_ORIGIN", PAGE_ORIGIN))
    with TemporaryDirectory(prefix="ringo-bundles-") as temp:
        with ThreadingHTTPServer(("127.0.0.1", args.port), SharedReviewHandler) as server:
            server.frontend_origin = frontend
            server.public_host = urlsplit(api_origin).netloc
            server.members = MemberSessions(accounts)
            server.workbench = PhotoWorkbench(args.data_dir, args.soundfont or args.data_dir / "GeneralUser-GS.sf2")
            server.workbench.check_renderer()
            server.downloads = BundleDownloads(server.workbench, Path(temp))
            server.api_key, server.api_url, server.model = api_key, api_url, model
            print(f"Ringo API listening on 127.0.0.1:{args.port}", flush=True)
            try:
                server.serve_forever()
            finally:
                server.downloads.worker.shutdown(wait=True)


if __name__ == "__main__":
    main()
