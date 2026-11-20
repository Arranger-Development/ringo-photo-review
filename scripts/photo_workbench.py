"""Local batch queue, render checkpoints and blind listening records."""

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from random import SystemRandom
from shutil import copyfile
from tempfile import TemporaryDirectory
from threading import RLock
from time import perf_counter
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

from jsonschema import ValidationError, validate

from render_photo_arrangements import check_render_dependencies, command, render_arrangements
from run_photo_arrangement import (ArrangementRejections, DEFAULT_CATALOG, SPECS, generate_photo_arrangements,
                                   generate_photo_intent, read_json, validate_arrangements, write_json)


ACTIVE = {"queued", "reading", "arranging", "repairing", "rendering"}
SCORE_FIELDS = ("photoMatch", "arrangement", "timbre")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def persist(path, value):
    pending = path.with_suffix(".tmp")
    write_json(pending, value)
    pending.replace(path)


class PhotoWorkbench:
    def __init__(self, data_dir, soundfont):
        self.directory = Path(data_dir)
        self.soundfont = Path(soundfont)
        self.catalog = read_json(DEFAULT_CATALOG)
        self.jobs = {}
        self.lock = RLock()
        self.worker = ThreadPoolExecutor(max_workers=1)
        self.font_identity = None
        self.directory.mkdir(parents=True, exist_ok=True)
        self.log_path = self.directory / "events.jsonl"
        for path in (self.directory / "photos").glob("*/state.json"):
            job = read_json(path)
            self.jobs[job["id"]] = job
            if job["phase"] in ACTIVE:
                self.update(job["id"], phase="failed", error="上次任务中断，可从已保存的阶段继续。")
                self.event("job_interrupted", job["id"], lastPhase=job["phase"])

    def event(self, kind, job_id=None, **fields):
        with self.lock:
            job = self.jobs.get(job_id, {})
            record = {"schemaVersion": 1, "at": now(), "event": kind, **fields}
            if job_id is not None:
                record.update(photoId=job_id, batchId=job.get("batchId"), attempt=job.get("attempt", 1))
            with self.log_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    @contextmanager
    def operation(self, kind, job_id=None, **fields):
        operation_id = uuid4().hex
        started = perf_counter()
        details = {}
        self.event(f"{kind}_started", job_id, operationId=operation_id, **fields)
        try:
            yield details
        except Exception as error:
            details["errorType"] = type(error).__name__
            if isinstance(error, ArrangementRejections):
                details["rejectedCandidates"] = [issue["position"] for issue in error.issues]
                details["candidateIssues"] = [{"position": issue["position"], "reason": issue["reason"]}
                                              for issue in error.issues]
            elif isinstance(error, ValidationError):
                details.update(validationPath=error.json_path, validator=error.validator)
            raise
        finally:
            duration = (perf_counter() - started) * 1000
            if kind == "qwen_call":
                details["upstreamAttempted"] = "requestAt" in details
                details["localProcessingMs"] = round(max(0, duration - details.get("upstream_ms", 0)), 1)
            self.event(f"{kind}_finished", job_id, operationId=operation_id, durationMs=round(duration, 1),
                       outcome="failed" if details.get("errorType") else "ok", **fields, details=details)

    def folder(self, job_id):
        return self.directory / "photos" / job_id

    def thumbnail(self, job_id):
        folder = self.folder(job_id)
        target = folder / "thumbnail.jpg"
        if not target.is_file():
            with TemporaryDirectory(prefix="thumbnail-", dir=folder) as temp:
                output = Path(temp) / target.name
                command(["ffmpeg", "-nostdin", "-loglevel", "error", "-threads", "1", "-filter_threads", "1",
                         "-i", str(folder / "photo"), "-vf", "scale=96:96:force_original_aspect_ratio=decrease",
                         "-frames:v", "1", "-threads", "1", "-update", "1", str(output)])
                output.replace(target)
        return target.read_bytes()

    def check_renderer(self):
        if not self.soundfont.is_file():
            raise ValueError("后台没有找到 GeneralUser GS 音色库。")
        fingerprint = self.soundfont.stat().st_mtime_ns, self.soundfont.stat().st_size
        if fingerprint != self.font_identity:
            check_render_dependencies(self.soundfont, self.catalog)
            self.font_identity = fingerprint

    def update(self, job_id, **fields):
        with self.lock:
            revised = {**self.jobs[job_id], **fields}
            persist(self.folder(job_id) / "state.json", revised)
            self.jobs[job_id] = revised

    def view(self, job_id):
        with self.lock:
            return {key: value for key, value in self.jobs[job_id].items() if key != "apiUrl"}

    def listing(self):
        with self.lock:
            ordered = sorted(self.jobs.values(), key=lambda job: (job["createdAt"], job["id"]))
            return [self.view(job["id"]) for job in ordered]

    def submit(self, job_id, batch_id, name, photo, mime_type, count, api_key, api_url, model, upload_ms=None, *, owner=None):
        photo_hash = sha256(photo).hexdigest()
        with self.lock:
            if job_id in self.jobs:
                saved = self.jobs[job_id]
                if (saved["batchId"], saved["photoSha256"], saved["count"], saved.get("owner")) != (
                    batch_id, photo_hash, count, owner
                ):
                    raise ValueError("照片任务编号已被另一张照片使用。")
                return self.view(job_id)
            if sum(job["batchId"] == batch_id for job in self.jobs.values()) >= 100:
                raise ValueError("每批最多 100 张照片。")
            self.check_renderer()
            folder = self.folder(job_id)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "photo").write_bytes(photo)
            self.jobs[job_id] = {
                "id": job_id, "batchId": batch_id, "name": name, "photoSha256": photo_hash,
                "mimeType": mime_type, "count": count, "model": model, "apiUrl": api_url,
                "createdAt": now(), "queuedAt": now(), "attempt": 1,
                "phase": "queued", "error": None, "raters": [],
            }
            if owner is not None:
                self.jobs[job_id]["owner"] = owner
            persist(folder / "state.json", self.jobs[job_id])
            self.event("job_queued", job_id, photoBytes=len(photo), mimeType=mime_type, model=model,
                       candidateCount=count, uploadHandlerMs=upload_ms, catalogVersion=self.catalog["catalogVersion"])
            self.worker.submit(self.run_job, job_id, api_key)
            return self.view(job_id)

    def retry(self, job_id, api_key):
        with self.lock:
            if self.jobs[job_id]["phase"] == "failed":
                self.check_renderer()
                self.update(job_id, phase="queued", error=None, queuedAt=now(),
                            attempt=self.jobs[job_id].get("attempt", 1) + 1)
                self.event("job_requeued", job_id)
                self.worker.submit(self.run_job, job_id, api_key)
            return self.view(job_id)

    def run_job(self, job_id, api_key):
        job = self.jobs[job_id].copy()
        folder = self.folder(job_id)
        intent_file, score_file, pending_file = (folder / name for name in ("intent.json", "arrangements.json", "pending.json"))
        credentials = job["apiUrl"], api_key, job["model"]
        started = perf_counter()
        queue_ms = (datetime.now(timezone.utc) - datetime.fromisoformat(job.get("queuedAt", job["createdAt"]))).total_seconds() * 1000
        self.event("job_started", job_id, queueMs=round(max(0, queue_ms), 1),
                   resumeIntent=intent_file.exists(), resumeArrangements=score_file.exists(), example=job.get("example", False))
        try:
            self.check_renderer()
            if not intent_file.exists():
                self.update(job_id, phase="reading")
                photo = base64.b64encode((folder / "photo").read_bytes()).decode("ascii")
                with self.operation("qwen_call", job_id, stage="intent", model=job["model"]) as timing:
                    intent = generate_photo_intent(*credentials, job["mimeType"], photo, fast_image=True, timing=timing)
                persist(intent_file, intent)
            else:
                intent = read_json(intent_file)
            if not score_file.exists():
                pending = read_json(pending_file) if pending_file.exists() else None
                for _ in range(2):
                    stage = "repairing" if pending else "arranging"
                    self.update(job_id, phase=stage)
                    try:
                        with self.operation("qwen_call", job_id, stage=stage, model=job["model"],
                                            candidateCount=job["count"],
                                            retainedCandidates=(pending or {}).get("keep_positions", [])) as timing:
                            result = generate_photo_arrangements(*credentials, intent, self.catalog, job["count"],
                                                                timing=timing, **(pending or {}))
                    except ArrangementRejections as error:
                        failed = {issue["position"] for issue in error.issues}
                        pending = {"previous": error.result,
                                   "keep_positions": [i for i in range(1, job["count"] + 1) if i not in failed]}
                        persist(pending_file, pending)
                        if len(failed) == job["count"]:
                            raise
                    else:
                        persist(score_file, result)
                        break
                if not score_file.exists():
                    raise ValueError("部分候选仍未通过校验。重试时会保留已经通过的谱面。")
            self.update(job_id, phase="rendering")
            with self.operation("audio_render", job_id, candidateCount=job["count"],
                                catalogVersion=self.catalog["catalogVersion"],
                                soundfontSha256=self.catalog["soundfontSha256"]) as timing:
                timing["candidates"] = self.render(job_id)
        except ValidationError as error:
            self.update(job_id, phase="failed", error=f"模型返回的 JSON 格式有误（{error.json_path}）。")
        except (ValueError, OSError, KeyError, TypeError, IndexError, AttributeError) as error:
            self.update(job_id, phase="failed", error=str(error).replace(api_key, "[密钥]") if api_key else str(error))
        finally:
            self.event("job_finished", job_id, durationMs=round((perf_counter() - started) * 1000, 1),
                       phase=self.view(job_id)["phase"])

    def render(self, job_id):
        folder = self.folder(job_id)
        score = read_json(folder / "arrangements.json")
        validate(score, read_json(SPECS / "photo-arrangements.schema.json"))
        validate_arrangements(score, self.catalog, self.jobs[job_id]["count"])
        order = list(range(len(score["candidates"])))
        SystemRandom().shuffle(order)
        with TemporaryDirectory(prefix="render-", dir=folder) as temp:
            work = Path(temp)
            manifest = render_arrangements(score["candidates"], self.catalog, self.soundfont, work, order)
            for candidate in manifest:
                name = f"{candidate['label']}.mp3"
                (work / name).replace(folder / name)
        persist(folder / "listen.json", manifest)
        self.update(job_id, phase="ready", error=None)
        return {candidate["label"]: candidate["render"] for candidate in manifest}

    def example(self, job_id, batch_id):
        folder = self.folder(job_id)
        photo = SPECS.parents[1] / "output" / "qwen-midi-eval" / "input" / "night-drive.jpg"
        with self.lock:
            if job_id in self.jobs:
                return self.view(job_id)
            self.check_renderer()
            folder.mkdir(parents=True, exist_ok=True)
            copyfile(photo, folder / "photo")
            example = read_json(SPECS / "photo-arrangements.example.json")
            example["catalogVersion"] = self.catalog["catalogVersion"]
            persist(folder / "intent.json", read_json(SPECS / "photo-music-intent.example.json"))
            persist(folder / "arrangements.json", example)
            self.jobs[job_id] = {"id": job_id, "batchId": batch_id, "name": "内置示例", "mimeType": "image/jpeg",
                                 "photoSha256": sha256(photo.read_bytes()).hexdigest(), "count": 4,
                                 "model": "example", "apiUrl": "", "createdAt": now(), "queuedAt": now(), "attempt": 1, "phase": "queued",
                                 "error": None, "raters": [], "example": True}
            persist(folder / "state.json", self.jobs[job_id])
            self.event("job_queued", job_id, example=True, candidateCount=4)
            self.worker.submit(self.run_job, job_id, "")
            return self.view(job_id)

    def listening(self, job_id):
        job = self.view(job_id)
        if job["phase"] != "ready":
            raise ValueError("这张照片还没有完成试听渲染。")
        folder = self.folder(job_id)
        parts = [{"id": c["id"], "label": c["label"]} for c in read_json(folder / "listen.json")]
        return {"candidates": parts, "ratings": [read_json(path) for path in sorted(folder.glob("rating-*.json"))]}

    def rate(self, job_id, payload, *, imported_at=None):
        with self.lock:
            job = self.view(job_id)
            candidates = self.listening(job_id)["candidates"]
            refs = [candidate["id"] for candidate in candidates]
            rater = payload["raterId"].strip()
            note = payload["note"].strip()
            scores = payload["scores"]
            favorites = payload["favorites"]
            none = payload["none"]
            if not 0 < len(rater) <= 48 or len(note) > 1000:
                raise ValueError("请填写评审名（最多 48 字），备注最多 1000 字。")
            if set(scores) != set(refs) or type(none) is not bool or not isinstance(favorites, list):
                raise ValueError("评分的候选与试听不一致。")
            if (not none and not favorites) or (none and favorites) or not set(favorites) <= set(refs):
                raise ValueError("请选择首选或「都不合适」。")
            if "usable" in payload:
                usable = payload["usable"]
                if (not isinstance(usable, list) or len(set(usable)) != len(usable)
                        or not set(favorites) <= set(usable) <= set(refs) or none == bool(usable)):
                    raise ValueError("首选必须可用。选择「都不合适」时，所有候选均应为不可用。")
            for score in scores.values():
                if set(score) != set(SCORE_FIELDS) or any(type(score[k]) is not int or not 1 <= score[k] <= 5 for k in SCORE_FIELDS):
                    raise ValueError("请为每个候选填写三项 1–5 分评分。")
            record = {"schemaVersion": 1, "photoId": job_id, "photoSha256": job["photoSha256"],
                      "raterId": rater, "displayOrder": refs, "scores": scores, "favorites": favorites,
                      "none": none, "note": note, "ratedAt": imported_at or now()}
            if "usable" in payload:
                record.update(schemaVersion=2, usable=usable)
            digest = sha256(rater.encode()).hexdigest()
            path = self.folder(job_id) / f"rating-{digest}.json"
            if imported_at is not None and path.is_file():
                saved_at = read_json(path)["ratedAt"]
                if datetime.fromisoformat(saved_at) >= datetime.fromisoformat(imported_at):
                    return None
            persist(path, record)
            self.update(job_id, raters=sorted(set(job["raters"]) | {rater}))
            self.event("rating_saved", job_id, candidateCount=len(refs), favoriteCount=len(favorites), none=none,
                       ratingVersion=record["schemaVersion"], usableCount=len(usable) if "usable" in record else None)
            return record

    def full_export(self, destination):
        """Write an offline playback bundle with the original candidate identities."""
        jobs = [job for job in self.listing() if job["phase"] == "ready" and not job.get("example")]
        if not jobs:
            raise ValueError("评分库还没有可以试听的照片。")
        with ZipFile(destination, "w", compression=ZIP_DEFLATED, allowZip64=False) as archive:
            for job in jobs:
                source = self.folder(job["id"])
                base = f"photo-workbench/photos/{job['id']}"
                fields = ("id", "batchId", "name", "mimeType", "photoSha256", "count", "model", "createdAt", "phase")
                state = {key: job[key] for key in fields}
                archive.writestr(f"{base}/state.json", json.dumps(state, ensure_ascii=False))
                for name in ("intent.json", "arrangements.json", "listen.json"):
                    archive.write(source / name, f"{base}/{name}")
                archive.write(source / "photo", f"{base}/photo", compress_type=ZIP_STORED)
                for candidate in read_json(source / "listen.json"):
                    name = f"{candidate['label']}.mp3"
                    archive.write(source / name, f"{base}/{name}", compress_type=ZIP_STORED)
                if (source / "thumbnail.jpg").is_file():
                    archive.write(source / "thumbnail.jpg", f"{base}/thumbnail.jpg", compress_type=ZIP_STORED)

    def export(self, batch_id=None):
        library = batch_id is None
        jobs = self.listing()
        if library:
            jobs = [job for job in jobs if not job.get("example")]
        else:
            jobs = [job for job in jobs if job["batchId"] == batch_id]
        if not jobs:
            raise ValueError("评分库还没有照片。" if library else "找不到这个批次。")
        stream = BytesIO()
        ratings = []
        manifest = {"schemaVersion": 2, "scope": "library", "photos": []} if library else {
            "schemaVersion": 1, "batchId": batch_id, "photos": []}
        job_ids = {job["id"] for job in jobs}
        with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
            for index, job in enumerate(jobs, 1):
                folder = self.folder(job["id"])
                base = f"{index:03d}-{job['id'][:8]}"
                photo = {"photoId": job["id"], "name": job["name"], "photoSha256": job["photoSha256"],
                         "phase": job["phase"], "model": job["model"], "example": job.get("example", False)}
                if library:
                    photo.update(batchId=job["batchId"], createdAt=job["createdAt"])
                for name, field in (("arrangements.json", "scorePath"), ("intent.json", "intentPath"),
                                    ("pending.json", "pendingPath")):
                    if (folder / name).is_file() and (field != "pendingPath" or job["phase"] != "ready"):
                        photo[field] = f"{base}/{name}"
                        archive.write(folder / name, photo[field])
                if job["phase"] == "ready":
                    photo["candidates"] = read_json(folder / "listen.json")
                manifest["photos"].append(photo)
                ratings.extend(read_json(path) for path in sorted(folder.glob("rating-*.json")))
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            archive.writestr("ratings.jsonl", "".join(json.dumps(rating, ensure_ascii=False) + "\n" for rating in ratings))
            with self.lock:
                events = self.log_path.read_text(encoding="utf-8").splitlines() if self.log_path.exists() else []
            field, identifiers = ("photoId", job_ids) if library else ("batchId", {batch_id})
            archive.writestr("events.jsonl", "".join(line + "\n" for line in events
                                                  if json.loads(line).get(field) in identifiers))
        return stream.getvalue()
