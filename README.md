# ScriptReader

ScriptReader is a powerful, locally-run web application designed to help screenwriters and filmmakers experience their scripts through dynamic, multi-voice "table reads." 

By leveraging advanced in-browser neural Text-to-Speech (TTS), ScriptReader can parse a script, assign distinct voices to each character, and read the dialogue aloud—all without sending your private scripts to the cloud or requiring expensive API keys.

## Key Features

* **Multi-Voice Table Reads**: Assign unique voices to different characters in your screenplay. The application intelligently switches between voices during dialogue scenes to simulate a real ensemble cast, each seated at a stable position in the stereo field.
* **Overlapping Dialogue**: Characters can talk over each other. A line ending in `--` is cut off by whoever speaks next; Fountain's `^` dual-dialogue marker makes two characters speak at once. See [Overlap and pacing notation](#overlap-and-pacing-notation).
* **Authored Pacing**: A `[[pace: rapid]]` note makes an argument crackle and `[[pace: droning]]` makes a lecture drag — tightening or stretching both the gaps *and* the delivery speed until the next directive or scene heading.
* **Format Support**: Upload scripts in standard industry formats, including **Fountain** text files and **PDFs**.
* **Private Local Processing**: Kokoro and the optional Studio Local engine run entirely in your browser through WebGPU (falling back to WebAssembly). A cloud engine is available only as an explicit opt-in.
* **Studio Local Voices**: Install Chatterbox once (about 1.5 GB), then create expressive character voices from private 5–10 second reference recordings. Model files and references remain on the device and work offline after caching.
* **Bundled Voice Catalog**: Cast from audiobook narrators that ship with the app — searchable by age, accent, gender, vocal register and pace. Register and pace are measured from the audio itself; age and accent come from [LibriTTS-P](https://github.com/line/libritts-p)'s human annotations and the [parler-tts speaker descriptions](https://huggingface.co/datasets/parler-tts/libritts-r-filtered-speaker-descriptions), never guessed from the clip. The clips come from the [LibriTTS-R](https://www.openslr.org/141/) corpus, all three under CC BY 4.0, so browsing needs no account, no API key, and no network.
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
* **Audio Engine**: Web Audio API with Kokoro for fast local reads, Chatterbox for high-quality local character voices, and an optional cloud provider.
* **Neural Inference**: `kokoro-js` and `@huggingface/transformers`, each isolated in a dedicated Web Worker to prevent UI blocking.
* **Parsing**: Custom Fountain parsing and PDF text extraction.

## How the audio pipeline works

Seamless playback is the whole point of a table read, so the audio path is built
around one idea: **never make the listener wait for the renderer.**

```
script element
  ↓  overlap-pacing.js         who overlaps whom, and how fast the passage runs
  ↓  performance-director.js   direction → tempo / pitch / level / filter / pan, split into chunks
render unit
  ↓  selected engine           priority-queued synthesis, deduped + cached as AudioBuffers
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
* **Studio Local pre-renders continuously.** Chatterbox renders the upcoming
  screenplay in bounded batches as soon as the engine and cast are ready. The
  transport shows how much is complete and unlocks Play once the measured render
  rate and available runway indicate that playback can stay ahead of synthesis.
* **Studio renders are durable.** Completed Chatterbox chunks are stored as
  bounded PCM16 records in IndexedDB (up to 768 MB), so reopening a script or
  replaying a line does not pay the synthesis cost again. Changing a reference
  recording changes its render key, preventing an old cloned voice from leaking
  into the refreshed cast.
* **RunPod is remote compute with browser-owned persistence.** After explicit
  cloud consent, the dedicated worker pre-renders only the active script and is
  torn down when that render ends. It keeps speaker prompts only in process
  memory and never writes screenplay text, references, or audio to server-side
  storage. Resume data and completed render chunks remain in the same bounded
  browser stores used by the local workflow.

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

## Deploying

The build is fully static — there is no server, no API key, and no backend. All
parsing and inference happens in the visitor's browser, so a deployed copy is
exactly as private as a local one: the host only ever sees a request for files,
and scripts never leave the machine reading them.

Deployed to Cloudflare Workers at `scripts.reef.fish` as an assets-only Worker:
`wrangler.toml` declares `[assets]` and no `main`, so `dist/` is served straight
off the edge with no script in the request path.

Workers Builds settings:

| Field | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Path to the Worker | `/` (repo root, where `wrangler.toml` lives) |

`versions upload` publishes a preview without promoting it to the live URL,
which is what makes a branch build safe to run against the same Worker.

**`name` in `wrangler.toml` must match the Worker that owns the custom domain.**
Deploying under a different name silently creates a second Worker and leaves the
domain serving whatever was there before — the deploy succeeds and the site
never changes.

Publishing from a laptop is the same command:

```bash
npm run build
npx wrangler deploy
```

Do not put a deploy command in a *Pages* project's build config. Pages already
builds and uploads, so `wrangler pages deploy` there nests a deploy inside a
deploy and fails on authentication. That error reports your account role rather
than your token scope, so it can read "Super Administrator" and "Authentication
error" at once and send you looking for missing permissions that are not the
problem.

**Whatever you host on must send the headers in `public/_headers`.** The
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` pair in
`vite.config.js` applies to the dev server only — Vite does not carry it into
the build. Those headers enable `SharedArrayBuffer`, and therefore
multi-threaded WASM inference. They are a performance floor rather than a
requirement: WebGPU never needs them, and browsers without it fall back to
single-threaded inference, which works but is markedly slower. Hosts that cannot
set response headers at all (GitHub Pages) will run in that degraded mode.

Neural weights are deferred until the listener chooses an engine. Kokoro is the
smaller fast-local option. Studio Local is an explicit roughly 1.5 GB install,
cached by the browser for later offline sessions; it is intended primarily for
desktop browsers with WebGPU.

### The RunPod worker

`server/` builds the Serverless worker image. It is written for one card — the
48 GB NVIDIA L40S — and takes that seriously: it loads the half-precision
language model, decodes up to 32 lines as a single batch, and keeps the
attention cache in GPU memory across decode steps rather than copying it back
through host memory every token. A worker that cannot find a CUDA execution
provider refuses to start instead of billing at GPU rates for CPU inference;
set `SCRIPTREADER_REQUIRE_GPU=0` for a deliberate local CPU run.

Cloned Chatterbox voices are held as conditioning tensors in worker memory,
bounded at 64 by an LRU so a long-lived worker cannot grow without limit;
`SCRIPTREADER_SPEAKER_CACHE_SIZE` changes the bound. Eviction is not a failure
the listener sees — the browser re-sends the reference recording once when a
worker reports a voice it no longer holds. `SCRIPTREADER_WORKER_CONCURRENCY`
(default 2) sets how many jobs a worker accepts at once; inference is
serialised per engine regardless, so this overlaps WAV encoding with the next
job rather than running two renders on one card.

The worker also answers OpenAI's `/v1/audio/speech` shape, so any
OpenAI-compatible client can point at it: `tts-1` and its siblings route to
Kokoro, and OpenAI's voice names resolve to their Kokoro equivalents
(`alloy` to `af_alloy`, and so on) rather than failing on a voice Kokoro has
never heard of.

The endpoint's own configuration lives in `scripts/runpod-endpoint.mjs` rather
than only in the RunPod console, because GPU selection there is a prioritised
fallback list and an endpoint that merely asks for "48 GB" can be answered with
a different card without saying so.

```bash
RUNPOD_API_KEY=... node scripts/runpod-endpoint.mjs
```

That prints the difference between the console and this repository; add
`--apply` to write it.

## Privacy & Security

Parsing is always local. Kokoro and Studio Local synthesis stay inside the
browser and require no connection after their model weights are cached. Studio
reference recordings are stored in IndexedDB on the same device. The OpenAI
engine is a separate, explicit opt-in and clearly identifies when screenplay
text will be sent to a cloud service.
