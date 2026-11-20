"""Run the two Qwen prompt contracts against one photo."""

import argparse
import base64
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from time import perf_counter
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

from jsonschema import ValidationError, validate


SPECS = Path(__file__).resolve().parents[1] / "docs" / "specs"
DEFAULT_CATALOG = SPECS / "photo-arrangements.full-timbres.json"
FULL_CATALOG_VERSION = "generaluser-gs-audition-v2"
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
FAST_IMAGE_MAX_PIXELS = 960 * 960
NOTE_FIELDS = ("startTick", "durationTicks", "midi", "velocity")
LOOP_END_TICK = 7680
COMPACT_NOTE_INSTRUCTIONS = "\n本次 API 使用紧凑事件格式。events 中的每个音符都是四个整数的数组 [startTick, durationTicks, midi, velocity]，按此顺序输出。"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def generate(api_url, api_key, model, prompt_file, schema_name, content, *, schema=None, prompt_suffix="", timing=None):
    if schema is None:
        schema = read_json(SPECS / f"{schema_name}.schema.json")
    prompt = (SPECS / prompt_file).read_text(encoding="utf-8") + prompt_suffix
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": content},
        ],
        "enable_thinking": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema_name.replace("-", "_"), "strict": True, "schema": schema},
        },
    }
    request = Request(
        f"{api_url.rstrip('/')}/chat/completions",
        data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    if timing is not None:
        timing.update(
            provider="dashscope", endpointHost=urlsplit(api_url).hostname, requestedModel=model,
            contract=schema_name, promptSha256=sha256(prompt.encode()).hexdigest(),
            schemaSha256=sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest(),
            requestBytes=len(request.data), streaming=False, thinking=False, timeoutSeconds=240,
            requestAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        )
    upstream_started = perf_counter()
    try:
        with urlopen(request, timeout=240) as response:
            if timing is not None:
                timing.update(httpStatus=response.status, responseHeadersMs=(perf_counter() - upstream_started) * 1000,
                              providerRequestId=response.headers.get("x-request-id") or response.headers.get("x-dashscope-request-id"),
                              retryAfter=response.headers.get("retry-after"))
            first_byte = response.read(1)
            if timing is not None and first_byte:
                timing["firstResponseByteMs"] = (perf_counter() - upstream_started) * 1000
            raw_response = first_byte + response.read()
            if timing is not None:
                timing.update(responseBytes=len(raw_response), responseComplete=True)
    except HTTPError as error:
        if timing is not None:
            timing.update(httpStatus=error.code, responseHeadersMs=(perf_counter() - upstream_started) * 1000,
                          providerRequestId=error.headers.get("x-request-id") or error.headers.get("x-dashscope-request-id"),
                          retryAfter=error.headers.get("retry-after"))
        error.close()
        raise ValueError(f"{schema_name}：百炼返回 HTTP {error.code}") from error
    except URLError as error:
        if timing is not None:
            timing["transportErrorType"] = type(error.reason).__name__
        raise
    finally:
        if timing is not None:
            timing["upstream_ms"] = (perf_counter() - upstream_started) * 1000
            timing["requestEndedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    envelope = json.loads(raw_response)
    if timing is not None:
        usage = envelope.get("usage") or {}
        timing.update(returnedModel=envelope.get("model"), completionId=envelope.get("id"),
                      providerCreatedAt=envelope.get("created"))
        timing["usage"] = {key: usage[key] for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                           if type(usage.get(key)) is int}
        for group, key in (("prompt_tokens_details", "cached_tokens"),
                           ("completion_tokens_details", "reasoning_tokens")):
            details = usage.get(group) or {}
            if type(details.get(key)) is int:
                timing["usage"][key] = details[key]
    choice = envelope["choices"][0]
    if timing is not None:
        timing["finishReason"] = choice.get("finish_reason")
    if choice["finish_reason"] != "stop":
        raise ValueError(f"{schema_name}：模型输出未完整结束（{choice['finish_reason']}）")
    result = json.loads(choice["message"]["content"])
    validate(result, schema)
    return result


def validate_intent(intent):
    tempo = intent["tempoBpmRange"]
    if tempo and tempo["min"] > tempo["max"]:
        raise ValueError("音乐意图的建议 BPM 区间 min 大于 max。")


class ArrangementRejections(ValueError):
    def __init__(self, result, issues):
        self.result = result
        self.issues = issues
        super().__init__("\n".join(f"第 {issue['position']} 套 · {issue['message']}" for issue in issues))


class InvalidCandidate(ValueError):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def candidate_fingerprint(candidate, timbres):
    percussion_tracks = 0
    tracks = []
    for track in candidate["tracks"]:
        timbre_id = track["timbreId"]
        if timbre_id not in timbres:
            raise InvalidCandidate("unknown_timbre", f"{timbre_id}：音色不在目录中。")
        timbre = timbres[timbre_id]
        is_percussion = timbre["kind"] == "percussion"
        percussion_tracks += is_percussion
        drum_notes = {note["midi"] for note in timbre.get("drumNotes", [])}
        drum_ranges = timbre.get("drumMidiRanges", [])
        end_by_note = {}
        events = []
        for event in track["events"]:
            start, midi = event["startTick"], event["midi"]
            duration = event["durationTicks"]
            end = start + duration
            if end > LOOP_END_TICK:
                raise InvalidCandidate("loop_overflow", f"{timbre_id}：MIDI {midi} 在 tick {start} 起音，结束于 {end}，超过四小节终点 {LOOP_END_TICK}。")
            if start < end_by_note.get(midi, 0):
                raise InvalidCandidate("note_overlap", f"{timbre_id}：MIDI {midi} 同音高重叠，前音结束于 tick {end_by_note[midi]}，后音在 tick {start} 起音。")
            in_range = (midi in drum_notes or any(low <= midi <= high for low, high in drum_ranges)) if is_percussion else (
                timbre.get("midiMin", 0) <= midi <= timbre.get("midiMax", 127)
            )
            if not in_range:
                raise InvalidCandidate("note_out_of_range", f"{timbre_id}：MIDI {midi} 不在该音色的音域或鼓件表中。")
            end_by_note[midi] = end
            events.append((start, midi, duration))
        tracks.append((timbre_id, tuple(events)))
    if percussion_tracks > 1:
        raise InvalidCandidate("multiple_drum_tracks", "有多条打击乐轨。")
    return candidate["bpm"], tuple(sorted(tracks))


def validate_arrangements(result, catalog, count, *, keep_positions=()):
    if result["catalogVersion"] != catalog["catalogVersion"]:
        raise ValueError("编配返回的 catalogVersion 与输入音色目录不一致。")
    if len(result["candidates"]) != count:
        raise ValueError(f"期望 {count} 套编配，收到 {len(result['candidates'])} 套。")
    timbres = {timbre["id"]: timbre for timbre in catalog["timbres"]}
    if len(timbres) != len(catalog["timbres"]):
        raise ValueError("输入音色目录有重复的 id。")
    scores = set()
    issues = []
    ordered = sorted(enumerate(result["candidates"], start=1), key=lambda item: item[0] not in keep_positions)
    for index, candidate in ordered:
        for track in candidate["tracks"]:
            track["events"].sort(key=lambda event: (event["startTick"], event["midi"]))
        try:
            score = candidate_fingerprint(candidate, timbres)
            if score in scores:
                raise InvalidCandidate("duplicate_candidate", "与另一套已通过校验的编配重复。")
            scores.add(score)
        except InvalidCandidate as error:
            issues.append({"position": index, "message": str(error), "reason": error.reason})
    if issues:
        raise ArrangementRejections(result, issues)


def generate_photo_intent(api_url, api_key, model, mime_type, photo_data, *, fast_image=False, timing=None):
    image = {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{photo_data}"}}
    if fast_image and model.startswith(("qwen3.8", "qwen3.7", "qwen3.6", "qwen3.5", "qwen3-vl")):
        image["max_pixels"] = FAST_IMAGE_MAX_PIXELS
    if timing is not None:
        timing.update(mimeType=mime_type, imageMaxPixels=image.get("max_pixels"))
    content = [
        image,
        {"type": "text", "text": "请把这张照片转换成音乐意图 JSON。"},
    ]
    intent = generate(api_url, api_key, model, "photo-to-music-intent.prompt.txt", "photo-music-intent", content, timing=timing)
    validate_intent(intent)
    return intent


def compact_arrangement_schema(count):
    schema = read_json(SPECS / "photo-arrangements.schema.json")
    schema["properties"]["candidates"].update(minItems=count, maxItems=count)
    note = schema["$defs"]["event"]["properties"]
    schema["$defs"]["event"] = {
        "type": "array",
        "minItems": len(NOTE_FIELDS),
        "maxItems": len(NOTE_FIELDS),
        "prefixItems": [note[field] for field in NOTE_FIELDS],
    }
    return schema


def catalog_for_prompt(catalog):
    if catalog["catalogVersion"] != FULL_CATALOG_VERSION:
        return catalog
    return {
        "catalogVersion": catalog["catalogVersion"],
        "pitched": [[timbre["id"], timbre["name"]] for timbre in catalog["timbres"] if timbre["kind"] == "pitched"],
        "percussion": [[timbre["id"], timbre["name"], timbre["drumMidiRanges"]]
                       for timbre in catalog["timbres"] if timbre["kind"] == "percussion"],
    }


def trim_ending_notes(result, timing):
    trimmed = 0
    for candidate in result["candidates"]:
        for track in candidate["tracks"]:
            for event in track["events"]:
                remaining = LOOP_END_TICK - event["startTick"]
                if event["durationTicks"] > remaining:
                    event["durationTicks"] = remaining
                    trimmed += 1
    if timing is not None and trimmed:
        timing["trimmed_notes"] = timing.get("trimmed_notes", 0) + trimmed
    return trimmed


def generate_photo_arrangements(api_url, api_key, model, intent, catalog, count, *, previous=None, keep_positions=(), timing=None):
    context = {"photoIntent": intent, "timbreCatalog": catalog_for_prompt(catalog), "candidateCount": count}
    repair_positions = []
    if previous is not None:
        validate(previous, read_json(SPECS / "photo-arrangements.schema.json"))
        recheck_legacy = previous["catalogVersion"] == "generaluser-gs-audition-v1" and catalog["catalogVersion"] == FULL_CATALOG_VERSION
        if recheck_legacy:
            # Existing v1 IDs retain the same SoundFont presets in the full catalog.
            previous = {**previous, "catalogVersion": FULL_CATALOG_VERSION}
        trimmed = trim_ending_notes(previous, timing)
        try:
            validate_arrangements(previous, catalog, count, keep_positions=keep_positions)
        except ArrangementRejections as rejected:
            if recheck_legacy or trimmed:
                raise
            repair_positions = [issue["position"] for issue in rejected.issues]
            keep_positions = [position for position in range(1, count + 1) if position not in repair_positions]
            context["candidateCount"] = len(repair_positions)
            context["repairIssues"] = [
                {"position": issue["position"], "message": issue["message"],
                 "candidate": previous["candidates"][issue["position"] - 1]}
                for issue in rejected.issues
            ]
            context["retainedDirections"] = [previous["candidates"][position - 1]["direction"] for position in keep_positions]
        else:
            return previous
    content = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if timing is not None:
        timing.update(catalogVersion=catalog["catalogVersion"], requestedCandidates=context["candidateCount"],
                      repairPositions=repair_positions)
    result = generate(api_url, api_key, model, "music-intent-to-arrangements.prompt.txt", "photo-arrangements-compact", content,
                      schema=compact_arrangement_schema(context["candidateCount"]), prompt_suffix=COMPACT_NOTE_INSTRUCTIONS,
                      timing=timing)
    for candidate in result["candidates"]:
        for track in candidate["tracks"]:
            track["events"] = [dict(zip(NOTE_FIELDS, event, strict=True)) for event in track["events"]]
    trim_ending_notes(result, timing)
    if repair_positions:
        if result["catalogVersion"] != catalog["catalogVersion"] or len(result["candidates"]) != len(repair_positions):
            raise ValueError("补生成结果的音色目录或套数不匹配。")
        for position, candidate in zip(repair_positions, result["candidates"]):
            previous["candidates"][position - 1] = candidate
        validate_arrangements(previous, catalog, count, keep_positions=keep_positions)
        return previous
    validate_arrangements(result, catalog, count)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photo", type=Path, help="输入 JPEG 或 PNG")
    parser.add_argument("--out", type=Path, required=True, help="JSON 输出目录")
    parser.add_argument("--count", type=int, choices=range(4, 9), default=4)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--reuse-intent", type=Path, help="复用同一张照片已保存的意图 JSON，只重跑第二段")
    args = parser.parse_args()

    api_key = os.environ.get("DASHSCOPE_API_KEY")
    api_url = os.environ.get("DASHSCOPE_BASE_URL")
    if not api_key or not api_url:
        parser.error("请设置 DASHSCOPE_API_KEY 和所在工作空间的 DASHSCOPE_BASE_URL（截至 /compatible-mode/v1）。")
    model = os.environ.get("DASHSCOPE_MODEL", "qwen3.8-flash")
    mime_type = IMAGE_TYPES.get(args.photo.suffix.lower())
    if not mime_type:
        parser.error("照片格式须为 JPEG 或 PNG。")

    catalog = read_json(args.catalog)
    args.out.mkdir(parents=True, exist_ok=True)
    arrangements_path = args.out / "arrangements.json"
    if arrangements_path.exists():
        parser.error("这个目录已有 arrangements.json。比较新一轮结果时请使用新的 --out 目录。")
    if args.reuse_intent:
        intent = read_json(args.reuse_intent)
        if isinstance(intent, dict) and intent.get("schemaVersion") == 1 and "musicIntent" in intent:
            intent = intent["musicIntent"]
        validate(intent, read_json(SPECS / "photo-music-intent.schema.json"))
        validate_intent(intent)
    else:
        photo_data = base64.b64encode(args.photo.read_bytes()).decode("ascii")
        intent = generate_photo_intent(api_url, api_key, model, mime_type, photo_data)
    write_json(args.out / "intent.json", intent)
    print(f"音乐意图已保存到 {args.out / 'intent.json'}", flush=True)

    arrangements = generate_photo_arrangements(api_url, api_key, model, intent, catalog, args.count)
    write_json(arrangements_path, arrangements)
    print(f"已保存 {args.count} 套编配到 {arrangements_path}")


if __name__ == "__main__":
    try:
        main()
    except (ValidationError, ValueError, OSError, KeyError, IndexError) as error:
        print(f"试跑失败：{error}", file=sys.stderr)
        sys.exit(1)
