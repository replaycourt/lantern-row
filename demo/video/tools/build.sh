#!/usr/bin/env bash
# Build the demo video from storyboard.json and the recorded takes.
#
#   TAKES=/path/to/takes demo/video/tools/build.sh            # full build
#   STILLS=2,40,70 TAKES=… demo/video/tools/build.sh           # also export these seconds as PNGs for a check
#
# Environment:
#   TAKES  directory holding the recorded takes, one subdirectory per name in storyboard.json's
#          meta.takes (made by capture.mjs). Required.
#   OUT    the MP4 to write (default: web/media/lantern-row-demo.mp4)
#   WORK   scratch directory for voice clips, frames and binaries (default: $TMPDIR/lantern-row-video).
#          Frames take a few GB; nothing in WORK is needed after the build.
#   WRAP   optional command prefix for every step, e.g. a memory/time cap wrapper.
#   CHROME path of the Chrome binary (default: the macOS app bundle)
#
# Needs macOS (afconvert, swiftc with AVFoundation), Node >= 22, Python 3.8+, Google Chrome and the
# voice (see README.md). No ffmpeg.
set -euo pipefail

VIDEO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$VIDEO/../.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/lantern-row-video}"
WORK="${WORK%/}"
WRAP="${WRAP:-}"
OUT="${OUT:-$ROOT/web/media/lantern-row-demo.mp4}"
: "${TAKES:?set TAKES to the directory holding the recorded takes (see README.md)}"
mkdir -p "$WORK/bin" "$(dirname "$OUT")"

meta() { python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['meta'][sys.argv[2]])" "$VIDEO/storyboard.json" "$1"; }

echo "== 1/5 voiceover, timeline, subtitles"
$WRAP python3 -I "$VIDEO/tools/voice.py" --storyboard "$VIDEO/storyboard.json" --takes "$TAKES" --work "$WORK" --srt "$VIDEO/lantern-row-demo.srt"

echo "== 2/5 frames (headless Chrome)"
$WRAP node "$VIDEO/tools/compose.mjs" --work "$WORK"

echo "== 3/5 compile encoder and probe"
[ -x "$WORK/bin/encode" ] || $WRAP swiftc -O -swift-version 5 "$VIDEO/tools/encode.swift" -o "$WORK/bin/encode" 2>/dev/null
[ -x "$WORK/bin/probe" ] || $WRAP swiftc -O -swift-version 5 "$VIDEO/tools/probe.swift" -o "$WORK/bin/probe" 2>/dev/null

echo "== 4/5 encode H.264 + AAC"
$WRAP "$WORK/bin/encode" --manifest "$WORK/frames/manifest.txt" --audio "$WORK/voice.wav" \
  --out "$OUT" --fps "$(meta fps)" --width "$(meta width)" --height "$(meta height)" \
  --vbitrate "$(meta videoBitrate)" --abitrate "$(meta audioBitrate)"

echo "== 5/5 check"
$WRAP "$WORK/bin/probe" "$OUT" ${STILLS:+--stills "$STILLS" --out "$WORK/check"}
