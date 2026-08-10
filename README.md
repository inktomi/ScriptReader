# ScriptReader

ScriptReader is a powerful, locally-run web application designed to help screenwriters and filmmakers experience their scripts through dynamic, multi-voice "table reads." 

By leveraging advanced in-browser neural Text-to-Speech (TTS), ScriptReader can parse a script, assign distinct voices to each character, and read the dialogue aloud—all without sending your private scripts to the cloud or requiring expensive API keys.

## Key Features

* **Multi-Voice Table Reads**: Assign unique voices to different characters in your screenplay. The application intelligently switches between voices during dialogue scenes to simulate a real ensemble cast, each seated at a stable position in the stereo field.
* **Overlapping Dialogue**: Characters can talk over each other. A line ending in `--` is cut off by whoever speaks next; Fountain's `^` dual-dialogue marker makes two characters speak at once. See [Overlap and pacing notation](#overlap-and-pacing-notation).
* **Authored Pacing**: A `[[pace: rapid]]` note makes an argument crackle and `[[pace: droning]]` makes a lecture drag — tightening or stretching both the gaps *and* the delivery speed until the next directive or scene heading.
* **Format Support**: Upload scripts in standard industry formats, including **Fountain** text files and **PDFs**.
* **100% Local Processing**: ScriptReader runs entirely in your browser. It uses WebGPU (falling back to WebAssembly) via Transformers.js to execute neural TTS models (like Kokoro) directly on your device. Your data never leaves your computer.
* **Gapless Playback**: Lines are placed directly on the Web Audio timeline at sample accuracy, so the only silence you hear is deliberate theatrical timing. Sit back and the script reads itself.
* **Direction-Aware Performance**: Parentheticals actually change the delivery. `(whispering)` drops the level and slows the read; `(authoritative)` lowers the pitch and firms the tempo; `(over comms)` band-limits the voice like a radio; an `(O.S.)` cue moves it off-screen.
* **Teleprompter UI**: Follow along with the audio playback via a clean, auto-scrolling teleprompter interface that highlights the current active line.
* **Cast Studio**: Audition every voice against your own dialogue, then tune pitch and pace per character. Choices persist per script.

## How It Works

1. **Upload a Script**: Drag and drop a `.fountain` or `.pdf` file.
2. **Assign Voices**: Open the Cast Panel to map characters to specific synthetic voice profiles. 
3. **Play**: Hit play on the transport bar, and the application will orchestrate the table read.

## Overlap and pacing notation

Scripts say how they should be performed using Fountain's own conventions
wherever Fountain has one, plus `[[ ... ]]` notes — the one syntax a
screenwriting app carries through without trying to typeset it. Nothing here is
required; an unmarked script reads exactly as it always did.

| Mark | Meaning |
|---|---|
| Dialogue ending `--` or `—` | The speaker is cut off by whoever speaks next |
| Dialogue starting `--` or `—` | This line cuts in |
| `^` after a character cue | Fountain dual dialogue — speaks *with* the previous character |
| `(interrupting)`, `(cutting in)`, `(talking over)` | Interrupt, stated outright |
| `(overlapping)`, `(simultaneously)`, `(in unison)` | Simultaneous, stated outright |
| `(rapidly)`, `(slowly)`, `(drawling)` | Nudge one line's pace |
| `[[pace: rapid]]` | Set the pace until the next directive or scene heading |

Pace profiles are `rapid`, `snappy`, `natural`, `measured`, `dramatic`, and
`droning` (plus aliases like `fast`, `slow`, `quickly`). They compose with the
transport's pacing chip by multiplying, so the chip still works on a marked
script and a droning passage stays slower than its neighbours at every setting.

```
COUNSEL VANCE
Doctor Reyes, on the ninth you signed off on a shipment you had not inspected--

DOCTOR REYES
--I signed off on a manifest.

[[pace: droning]]

CHAIRMAN HOLT
We will recess for fifteen minutes.
```

Load the bundled **Crossfire** sample to hear all of it in about a minute.
Appending `?debug=parse` to the URL prints a table of how every line was
understood — who overlaps whom, where the pace changes, and what each line will
actually be asked to say.

An imported PDF gets the text-derived half of this for free (`--` and
`(interrupting)`), since neither depends on Fountain syntax. `^` and `[[pace:]]`
have no PDF equivalent.

## Technical Stack

* **Frontend**: Vanilla JavaScript (ESModules) and CSS, bundled with Vite.
* **Audio Engine**: Web Audio API combined with `kokoro-js` (a port of the Kokoro TTS model).
* **Neural Inference**: Handled via `@huggingface/transformers` running in a dedicated Web Worker to prevent UI blocking.
* **Parsing**: Custom Fountain parsing and PDF text extraction.

## How the audio pipeline works

Seamless playback is the whole point of a table read, so the audio path is built
around one idea: **never make the listener wait for the renderer.**

```
script element
  ↓  overlap-pacing.js         who overlaps whom, and how fast the passage runs
  ↓  performance-director.js   direction → tempo / pitch / level / filter / pan, split into chunks
render unit
  ↓  kokoro-engine.js          priority-queued synthesis, deduped + cached as AudioBuffers
audio buffer
  ↓  playback-scheduler.js     placed on the AudioContext timeline at an absolute start time
speaker
```

* **`audio-manager.js`** runs a 60 ms loop that keeps ~28 s of audio *requested* and
  ~1.6 s *scheduled*, tags each request with its distance from the playhead, and
  emits teleprompter events off the audio clock rather than off timers.
* **Scheduling, not chaining.** Each line is committed to the timeline with
  `source.start(when)` the moment its buffer exists. Nothing waits on an `onended`
  callback, so a busy main thread cannot open a hole between two lines.
* **A unit names the edge it starts from.** Ordinary lines follow everything
  scheduled so far; an interrupter is placed relative to where its victim *would*
  have finished, and a simultaneous line relative to where its partner *started*.
  Overlap is therefore just a signed offset, not a second timeline.
* **The timeline edge never moves backwards.** It is the running maximum of every
  scheduled end time. A short line overlapping a long one must not shrink the
  buffered horizon, or the manager reads the collapse as starvation and stacks
  the next line on top of the one still sounding.
* **Overlapping lines are scheduled as one cluster.** The horizon check applies
  only between clusters — stopping halfway through would strand the second voice
  until the playhead nearly caught up, silently turning simultaneous speech back
  into a queue.
* **Truncation is a property of a render unit, decided when it is built** — never
  an operation applied to the timeline afterwards. A cut-off line is trimmed
  relative to its own natural end, which is what lets it be scheduled before the
  interrupter's start time is known.
* **Tempo and pitch are separated.** Kokoro's `speed` changes tempo but preserves
  pitch; Web Audio's `playbackRate` changes both. Synthesising at `tempo / pitch`
  and playing back at `pitch` cancels on tempo and compounds on pitch — which is
  what lets a direction genuinely reshape a delivery.
* **Pan is a playback parameter, not a synthesis one.** It rides on the unit and
  is applied by a node in the graph, so it stays out of the cache key and one
  rendered buffer serves every seat at the table.
* **Pause freezes the clock.** `AudioContext.suspend()` holds every scheduled
  source in place, so resuming continues mid-line with no re-render.
* **Cancellation is surgical.** A seek drops only *pending* lookahead; work
  already in flight still lands in the cache instead of being thrown away.

## Running Locally

To run the development server locally:

```bash
npm install
npm run dev
```

To build for production:

```bash
npm run build
npm run preview
```

## Privacy & Security

Because all parsing and neural inference happens locally inside your browser, ScriptReader is completely private by design. It does not require an internet connection after the initial loading of the model weights, making it safe for unreleased, confidential screenplays.
