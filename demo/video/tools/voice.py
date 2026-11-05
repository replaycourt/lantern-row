#!/usr/bin/env python3
"""Voiceover, timeline and subtitles for the Lantern Row demo video.

Reads storyboard.json and the events of the recorded takes, speaks every cue (Piper neural TTS, or
macOS `say` with "engine": "say"), measures each clip, resolves every scene's clips against the
takes' events, lays the cues out on a timeline and writes:

  <work>/timeline.json   scene, segment and cue times, read by compose.mjs
  <work>/voice.wav       48 kHz stereo 16-bit PCM, exactly as long as the video
  <srt>                  subtitles (one cue per caption)

A scene lasts as long as its clips (played at their speed), or as long as its cues need, whichever
is longer; a clip that runs out holds its last frame. With "fit": "stretch" the clips are slowed or
sped up to the cues instead.

Python 3.8+ standard library only; needs `afconvert` (macOS) and the voice engine. For Piper, set
LANTERN_PIPER_PYTHON (a Python with `piper-tts` installed) and LANTERN_PIPER_VOICES (the directory
holding <voice>.onnx and <voice>.onnx.json).
Usage: python3 -I voice.py --storyboard storyboard.json --takes <dir with one take per name> --work <dir> --srt <file>
"""
import argparse
import array
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import wave

RATE = 48000
PIPER_OPTIONS = {
    "lengthScale": "--length-scale",
    "noiseScale": "--noise-scale",
    "noiseW": "--noise-w-scale",
    "sentenceSilence": "--sentence-silence",
}


# ---- speech ---------------------------------------------------------------------------------------

def clip_path(work, voice, text):
    settings = json.dumps({k: voice.get(k) for k in ("engine", "name", "rate", *PIPER_OPTIONS)}, sort_keys=True)
    key = hashlib.sha256(f"{settings}|{text}".encode("utf-8")).hexdigest()[:16]
    return os.path.join(work, "voice", key)


def synthesize(voice, text, out):
    """Write `text` as speech to the audio file `out`; afconvert reads whatever format results."""
    if voice.get("engine", "say") == "say":
        cmd = ["say", "-v", voice["name"], "-o", out]
        if voice.get("rate"):
            cmd += ["-r", str(voice["rate"])]
        subprocess.run(cmd + [text], check=True)
        return
    python = os.environ.get("LANTERN_PIPER_PYTHON")
    voices = os.environ.get("LANTERN_PIPER_VOICES")
    if not python or not voices:
        sys.exit("voice engine piper needs LANTERN_PIPER_PYTHON and LANTERN_PIPER_VOICES (see README.md)")
    cmd = [python, "-I", "-m", "piper", "--model", os.path.join(voices, voice["name"] + ".onnx"), "--output-file", out]
    for key, flag in PIPER_OPTIONS.items():
        if voice.get(key) is not None:
            cmd += [flag, str(voice[key])]
    subprocess.run(cmd, input=text.encode("utf-8"), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def speak(work, voice, text):
    """Return mono 48 kHz int16 samples of `text` (cached by voice settings and text)."""
    base = clip_path(work, voice, text)
    wav = base + ".wav"
    if not os.path.exists(wav):
        os.makedirs(os.path.dirname(base), exist_ok=True)
        raw = base + (".aiff" if voice.get("engine", "say") == "say" else ".raw.wav")
        synthesize(voice, text, raw)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", raw, wav + ".tmp"], check=True)
        os.replace(wav + ".tmp", wav)
        os.remove(raw)
    with wave.open(wav, "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == RATE, wav
        data = array.array("h")
        data.frombytes(w.readframes(w.getnframes()))
    if sys.byteorder == "big":
        data.byteswap()
    return trim(data)


def trim(samples, threshold=60):
    """Cut leading/trailing near-silence of a clip, keeping 40 ms of margin."""
    n = len(samples)
    lo, hi = 0, n
    while lo < n and abs(samples[lo]) < threshold:
        lo += 1
    while hi > lo and abs(samples[hi - 1]) < threshold:
        hi -= 1
    margin = int(0.04 * RATE)
    return samples[max(0, lo - margin):min(n, hi + margin)]


# ---- the take's events ----------------------------------------------------------------------------

ANCHOR = re.compile(r"^([a-z-]+)(?::([^#+-]+?))?(?:#(\d+))?\s*(?:([+-])\s*(\d+(?:\.\d+)?))?$")


def load_events(take):
    events = []
    with open(os.path.join(take, "events.jsonl"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    t0 = next(e["t"] for e in events if e["ev"] == "record")
    for e in events:
        e["t"] -= t0
    return events


def resolve(events, ref):
    """A time in the take, in seconds since the recording began.

    A number is that time. Otherwise "<event>[:<text>][#<n>][+<s>|-<s>]": the n-th (1-based, default
    first) event of that name whose data contains <text> (case-insensitive, anywhere in its JSON),
    shifted by <s> seconds. Examples: "click:Restock", "night#3-0.5", "outcome:paid off+1".
    """
    if isinstance(ref, (int, float)):
        return float(ref)
    m = ANCHOR.match(ref.strip())
    if not m:
        sys.exit(f"bad anchor {ref!r}")
    name, text, n, sign, off = m.groups()
    n = int(n) if n else 1
    hits = [e for e in events if e["ev"] == name and (not text or text.strip().lower() in json.dumps(e, ensure_ascii=False).lower())]
    if len(hits) < n:
        sys.exit(f"anchor {ref!r}: only {len(hits)} matching event(s) in the take")
    t = hits[n - 1]["t"]
    if sign:
        t += float(off) * (1 if sign == "+" else -1)
    return t


# ---- output helpers -------------------------------------------------------------------------------

def fmt_srt(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def wrap2(text, width=58):
    """Break a caption into at most two balanced lines."""
    if len(text) <= width:
        return [text]
    words = text.split(" ")
    best, best_cost = [text], None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        cost = max(len(a), len(b))
        if best_cost is None or cost < best_cost:
            best, best_cost = [a, b], cost
    return best


# ---- main -----------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--storyboard", required=True)
    ap.add_argument("--takes", required=True, help="directory holding the takes named in meta.takes")
    ap.add_argument("--work", required=True)
    ap.add_argument("--srt", required=True)
    args = ap.parse_args()

    with open(args.storyboard, encoding="utf-8") as f:
        sb = json.load(f)
    v = sb["voice"]
    fps = sb["meta"]["fps"]
    take_dirs = {name: os.path.abspath(os.path.join(args.takes, name)) for name in sb["meta"]["takes"]}
    events = {name: load_events(d) for name, d in take_dirs.items()}
    default_take = sb["meta"]["takes"][0]
    os.makedirs(args.work, exist_ok=True)

    t = 0.0
    scenes, placed = [], []
    for scene in sb["scenes"]:
        start = t
        # the clips, resolved against the take
        clips = scene.get("clips") or ([scene["clip"]] if scene.get("clip") else [])
        segs = []
        for c in clips:
            take = c.get("take", default_take)
            src_from = resolve(events[take], c["from"])
            src_to = src_from + float(c["dur"]) if "dur" in c else resolve(events[take], c["to"])
            if src_to <= src_from:
                sys.exit(f"scene {scene['id']}: clip ends before it starts ({src_from:.2f} -> {src_to:.2f})")
            segs.append({"take": take, "from": round(src_from, 3), "to": round(src_to, 3), "speed": float(c.get("speed", 1))})
        clip_len = sum((s["to"] - s["from"]) / s["speed"] for s in segs)
        # the cues
        cursor = start + scene.get("leadIn", v["sceneLeadIn"])
        cues = []
        for cue in scene.get("cues", []):
            text = cue.get("say", cue["caption"])
            samples = speak(args.work, v, text)
            dur = len(samples) / RATE
            cues.append({"start": round(cursor, 3), "end": round(cursor + dur, 3), "caption": cue["caption"], **({"noCaption": True} if cue.get("noCaption") else {})})
            placed.append((cursor, samples))
            cursor += dur + cue.get("gapAfter", v["cueGap"])
        voice_len = (cursor - v["cueGap"] + scene.get("tail", v["sceneTail"]) - start) if cues else 0
        length = max(clip_len, voice_len, scene.get("minDuration", 0))
        if scene.get("fit") == "stretch" and segs and clip_len > 0:
            k = clip_len / length
            for s in segs:
                s["speed"] = round(s["speed"] * k, 4)
        # lay the segments on the output timeline
        out = start
        for s in segs:
            s["start"] = round(out, 3)
            out += (s["to"] - s["from"]) / s["speed"]
            s["end"] = round(out, 3)
        end = start + length
        scenes.append({"id": scene["id"], "start": round(start, 3), "end": round(end, 3), "segments": segs, "cues": cues})
        t = end
    t += v.get("endHold", 0)
    scenes[-1]["end"] = round(t, 3)
    frames = int(math.ceil(t * fps))
    duration = frames / fps

    # caption display windows: from cue start until shortly after it ends (never past the next cue)
    all_cues = [c for s in scenes for c in s["cues"]]
    for i, c in enumerate(all_cues):
        nxt = all_cues[i + 1]["start"] if i + 1 < len(all_cues) else duration
        c["showUntil"] = round(min(c["end"] + v.get("captionHold", 0.7), nxt - 0.05), 3)

    # audio: silence with every clip at its place, stereo
    total = int(round(duration * RATE))
    mono = array.array("h", bytes(2 * total))
    for at, samples in placed:
        off = int(round(at * RATE))
        n = min(len(samples), total - off)
        mono[off:off + n] = samples[:n]
    stereo = array.array("h", bytes(4 * total))
    stereo[0::2] = mono
    stereo[1::2] = mono
    if sys.byteorder == "big":
        stereo.byteswap()
    wav_path = os.path.join(args.work, "voice.wav")
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(stereo.tobytes())

    timeline = {"fps": fps, "frames": frames, "duration": duration, "takes": take_dirs, "scenes": scenes}
    with open(os.path.join(args.work, "timeline.json"), "w", encoding="utf-8") as f:
        json.dump(timeline, f, indent=1, ensure_ascii=False)

    with open(args.srt, "w", encoding="utf-8") as f:
        for i, c in enumerate(all_cues, 1):
            f.write(f"{i}\n{fmt_srt(c['start'])} --> {fmt_srt(c['showUntil'])}\n")
            f.write("\n".join(wrap2(c["caption"])) + "\n\n")

    print(f"duration {duration:.2f} s, {frames} frames at {fps} fps, {len(all_cues)} cues")
    for s in scenes:
        clip = sum((g["to"] - g["from"]) / g["speed"] for g in s["segments"])
        voice = (s["cues"][-1]["end"] - s["start"]) if s["cues"] else 0
        print(f"  {s['id']:<10} {s['start']:6.2f} - {s['end']:6.2f}  ({s['end'] - s['start']:5.2f} s; clips {clip:5.2f} s, voice {voice:5.2f} s)")


if __name__ == "__main__":
    main()
