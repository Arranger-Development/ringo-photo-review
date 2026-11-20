"""Render the verified GeneralUser GS arrangement format for blind listening."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path
import re
from shutil import which
import struct
from subprocess import PIPE, CalledProcessError, TimeoutExpired, run
from time import perf_counter


TARGET_LUFS = -18.0
TAIL_SECONDS = 1.8


def check_render_dependencies(soundfont, catalog):
    missing = [name for name in ("fluidsynth", "ffmpeg", "ffprobe") if not which(name)]
    if missing:
        raise ValueError(f"缺少音频工具：{', '.join(missing)}。")
    if not Path(soundfont).is_file():
        raise ValueError("后台没有找到 GeneralUser GS 音色库。")
    if sha256(Path(soundfont).read_bytes()).hexdigest() != catalog["soundfontSha256"]:
        raise ValueError("音色库与当前 GeneralUser GS 目录的版本不一致。")


def variable_length(value):
    parts = [value & 127]
    value >>= 7
    while value:
        parts.append(128 | (value & 127))
        value >>= 7
    return bytes(reversed(parts))


def encode_track(events, end_tick):
    last = 0
    data = bytearray()
    for tick, _, message in sorted(events):
        data.extend(variable_length(tick - last) + message)
        last = tick
    data.extend(variable_length(end_tick - last) + b"\xff\x2f\x00")
    return b"MTrk" + struct.pack(">I", len(data)) + data


def write_midi(path, candidate, timbres):
    ppq = candidate["ticksPerBeat"]
    beats = candidate["barCount"] * 4
    end_tick = beats * ppq
    tempo = round(60_000_000 / candidate["bpm"])
    meta = [(0, 0, b"\xff\x51\x03" + tempo.to_bytes(3, "big")), (0, 1, bytes.fromhex("ff580404021808"))]
    tracks = [encode_track(meta, end_tick)]
    pitched_channel = 0
    for part in candidate["tracks"]:
        timbre = timbres[part["timbreId"]]
        channel = 9 if timbre["kind"] == "percussion" else pitched_channel
        events = []
        if channel != 9:
            pitched_channel += 1
            events.append((0, 0, bytes([0xb0 | channel, 0, timbre["midiBank"]])))
        events.append((0, 1, bytes([0xc0 | channel, timbre["midiProgram"]])))
        for note in part["events"]:
            start = note["startTick"]
            events.append((start, 3, bytes([0x90 | channel, note["midi"], note["velocity"]])))
            events.append((start + note["durationTicks"], 2, bytes([0x80 | channel, note["midi"], 0])))
        tracks.append(encode_track(events, end_tick))
    path.write_bytes(struct.pack(">4sIHHH", b"MThd", 6, 1, len(tracks), ppq) + b"".join(tracks))
    return beats * tempo / 1_000_000 + TAIL_SECONDS


def command(args):
    try:
        return run(args, check=True, timeout=90, stdout=PIPE, stderr=PIPE, text=True)
    except (CalledProcessError, TimeoutExpired, OSError) as exc:
        raise ValueError(f"音频渲染失败（{args[0]}）。") from exc


def measure(path, filters):
    result = command(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", filters, "-f", "null", "-"])
    summary = result.stderr.rsplit("Summary:", 1)[-1]
    loudness = re.search(r"I:\s+([-\d.]+) LUFS", summary)
    peak = re.search(r"Peak:\s+([-\d.]+) dBFS", summary)
    if not (loudness and peak) or float(loudness[1]) <= -65:
        raise ValueError("有一套编配的试听是静音或音量过低。")
    return float(loudness[1]), float(peak[1])


def render_arrangements(candidates, catalog, soundfont, work, order):
    timbres = {timbre["id"]: timbre for timbre in catalog["timbres"]}

    def synthesize(index):
        started = perf_counter()
        midi, wave = work / f"{index}.mid", work / f"{index}.wav"
        duration = write_midi(midi, candidates[index], timbres)
        command(["fluidsynth", "-ni", "-g", "0.7", "-r", "44100", "-O", "float", "-T", "wav", "-o",
                 "synth.midi-bank-select=gs", "-F", str(wave), str(soundfont), str(midi)])
        length_filter = (f"apad=whole_dur={duration:.6f},atrim=end={duration:.6f},"
                         f"afade=t=out:st={duration - 0.15:.6f}:d=0.15")
        loudness, peak = measure(wave, f"{length_filter},ebur128=peak=true")
        return index, wave, duration, length_filter, loudness, peak, round((perf_counter() - started) * 1000, 1)

    with ThreadPoolExecutor(max_workers=4) as workers:
        waves = list(workers.map(synthesize, order))
        target = min(TARGET_LUFS, *(loudness - 2 - peak for _, _, _, _, loudness, peak, _ in waves))

        def export(entry):
            started = perf_counter()
            position, (index, wave, duration, filters, loudness, _, synth_ms) = entry
            label = chr(ord("A") + position)
            audio = work / f"{label}.mp3"
            command(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(wave), "-af",
                     f"{filters},volume={target - loudness:.3f}dB", "-c:a", "libmp3lame", "-q:a", "2",
                     "-metadata", f"title={label}", str(audio)])
            probe = command(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                             "default=nw=1:nk=1", str(audio)])
            if abs(float(probe.stdout) - duration) > 0.15:
                raise ValueError(f"试听 {label} 的音频时长异常。")
            actual_loudness, actual_peak = measure(audio, "ebur128=peak=true")
            if abs(actual_loudness - target) > 1.1 or actual_peak >= -0.3:
                raise ValueError(f"试听 {label} 的响度或峰值异常。")
            audio_hash = sha256(audio.read_bytes()).hexdigest()
            packed_score = json.dumps(candidates[index], ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            candidate_id = sha256(f"{catalog['catalogVersion']}\n{audio_hash}\n{packed_score}".encode()).hexdigest()
            return {"id": candidate_id, "label": label, "arrangementIndex": index, "audioSha256": audio_hash,
                    "render": {"synthesisAndMeasurementMs": synth_ms,
                               "encodeAndValidationMs": round((perf_counter() - started) * 1000, 1),
                               "durationSeconds": float(probe.stdout), "targetLufs": target,
                               "integratedLufs": actual_loudness, "truePeakDb": actual_peak,
                               "bytes": audio.stat().st_size}}

        return list(workers.map(export, enumerate(waves)))
