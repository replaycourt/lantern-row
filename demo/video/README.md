# Lantern Row demo video

`web/media/lantern-row-demo.mp4` is the demo video for the NEAR hackathon entry: 1920x1080, 30 fps, 122 s, H.264 (2.5 Mbit/s) with AAC stereo narration, burned-in captions, about 39 MB. `lantern-row-demo.srt` here has the same captions as a subtitle file.

The video is real gameplay. Every frame is a screenshot of the real page (`web/`) in headless Chrome, played through its own buttons against the real contract `lantern-row.testnet` on NEAR testnet. Nothing is mocked and no number is invented: the stall "Honey Lantern" (stall 25) was founded during the recording, and every night, report, call, listing and rank shown is what the chain returned. What the build adds on top is the narration, the captions, the hand cursor (drawn from the recorded click positions), a small live badge and the end card. Waits are cut or sped up; results are not touched.

## How it is made

```
capture.mjs  →  takes/<name>/frames/*.jpg + events.jsonl    (play the game, record the screen)
storyboard.json + voice.py  →  work/timeline.json, voice.wav, lantern-row-demo.srt
compose.mjs + compositor.html  →  work/frames/*.png           (cut, captions, cursor, end card)
encode.swift  →  lantern-row-demo.mp4;  probe.swift checks it and exports stills
```

1. **Record a take.** `capture.mjs` launches headless Chrome on the page, opens a stall (or returns to one), restocks, sets prices, watches nights pass and answers every call until one pays off, then opens the deed, lists the stall, and opens the ranks and the proof drawer. It records the DevTools screencast (1280x720 JPEG, 20 to 27 fps on a laptop) with a timestamp per frame, and an event log: every click and cursor move, every night change, report, call, outcome, banner, toast, sheet and transaction, with the time it was seen. Two takes went into the video: `play` (founding to the fifth night that paid off) and `deed` (the same stall a few nights later: deed, listing, ranks, proof).

2. **Cut it.** `storyboard.json` names, per scene, a stretch of a take by its events (`"from": "click:Restock-1.0"`, `"to": "walk-end#1+0.3"`), a playback speed, the narration and caption placement. Anchoring on events rather than seconds means a new take mostly needs no re-cutting.

3. **Speak it.** `voice.py` speaks every cue with [Piper](https://github.com/OHF-Voice/piper1-gpl) (`en_US-lessac-high`, slowed to length scale 1.2), measures the clips, resolves the scene anchors against the takes and lays everything out on one timeline. A scene lasts as long as its clips or its narration, whichever is longer.

4. **Compose it.** `compose.mjs` opens `compositor.html` in headless Chrome, which draws, for every output frame, the right recorded frame (scaled to 1920x1080) with the caption, the hand, the badge, a short crossfade at cuts that are not continuous, and the end card. The logo on the end card is drawn by the game's own `drawLogo`. Frames whose state did not change are captured once.

5. **Encode it.** `encode.swift` (AVFoundation, no ffmpeg) writes H.264 High at 2.5 Mbit/s (the picture is mostly still UI; `meta.videoBitrate` in the storyboard) with AAC audio. `probe.swift` prints the result and exports stills for a visual check.

## Scenes

| # | Scene | What is shown |
|---|---|---|
| 1 | Title | The real title screen: the glowing logo over the street (a storm was in force on testnet that night, hence the rain) |
| 2 | Open | A name is typed, one tap on *Open your stall*; the town catches up on idle nights, the clerk mints the stall (tx `4McUouPn…`), the camera slides to it at spot 23 |
| 3 | Restock | *Restock* and *Smart prices*: tea, oil, dumplings, silk and charms land on the counter with prices, stamped by one `act` transaction (`Ft7A8Uto…`) |
| 4 | Night | Night 526: villagers walk the row, stop, buy, coins fly, speech bubbles |
| 5 | Report | The report of night 525 (10 sales, +579 coin) and tonight's call: a festival of lamp oil starts next night, stock 6 lamp oil. Accepted (tx `EfXS7VrP…`) |
| 6 | Festival | Night 527: the Festival of lamp oil, with bunting and fireworks |
| 7 | Called it | The report of night 528: "Your call paid off: 5 lamp oil sold for 510", with the CALLED IT stamp |
| 8 | Deed | The stall as the NEP-171 token it is: the picture the contract draws, coin and goods inside, the founder's 5 % royalty; *List for sale* (tx `4bTPV44k…`) |
| 9 | For sale | The FOR SALE sign on the stall on the street, next to a report with another stamp |
| 10 | Ranks | The leaderboard: the stall among the six merchants |
| 11 | Proof | The proof drawer: contract, account, token, code hash, no contract keys, and the transactions of this tab |
| 12 | Why NEAR | End card: an unpatchable shared world, stalls as NFTs that own money and stock, play with no wallet; code and play links; a question |

The exact times are printed by `voice.py`.

## Rebuild

Requirements: macOS (`afconvert`, `swiftc` with AVFoundation), Google Chrome, Node 22+, Python 3.8+, and the voice:

```sh
python3 -m venv <venv> && <venv>/bin/pip install piper-tts
export LANTERN_PIPER_PYTHON=<venv>/bin/python
export LANTERN_PIPER_VOICES=<dir with en_US-lessac-high.onnx and .onnx.json>
```

The voice model is `en_US-lessac-high` from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/high). Without Piper, set `"engine": "say"` and a macOS voice name in `storyboard.json`. No ffmpeg and no npm packages are needed.

Record the takes (each take is a new night on testnet, so the game will differ; the storyboard anchors on events and usually still resolves, but a scene such as "called it" needs a take where a call did pay off, and the anchor texts may need a look):

```sh
python3 -m http.server 8765 --bind 127.0.0.1 &       # from the repository root
node demo/video/tools/capture.mjs --url http://127.0.0.1:8765/web/ --out takes/play --name "Honey Lantern" --nights 10
node demo/video/tools/capture.mjs --url http://127.0.0.1:8765/web/ --out takes/deed --profile takes/play/profile --skip-play --restock
```

Then build:

```sh
TAKES=takes demo/video/tools/build.sh                 # writes web/media/lantern-row-demo.mp4 and demo/video/lantern-row-demo.srt
STILLS=2,20,45,70 TAKES=takes demo/video/tools/build.sh   # also exports those seconds as PNGs into $WORK/check
```

`WORK` (default `$TMPDIR/lantern-row-video`) holds the voice clips, the composed frames (a few GB) and the compiled Swift tools; `WRAP` can prefix every step with a memory or time cap wrapper. A quick look at the cut without encoding: `node demo/video/tools/compose.mjs --work $WORK --stills 3,40,70`; after a change to the end card only, `--from 97` recomposes just the frames from that second on. The poster image `web/media/poster.png` is a still of the finished video.

The takes themselves (frames and profiles, with the browser's stall key) are not in the repository.
