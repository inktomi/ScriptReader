# ScriptReader

ScriptReader is a powerful, locally-run web application designed to help screenwriters and filmmakers experience their scripts through dynamic, multi-voice "table reads." 

By leveraging advanced in-browser neural Text-to-Speech (TTS), ScriptReader can parse a script, assign distinct voices to each character, and read the dialogue aloud—all without sending your private scripts to the cloud or requiring expensive API keys.

## Key Features

* **Multi-Voice Table Reads**: Assign unique voices to different characters in your screenplay. The application intelligently switches between voices during dialogue scenes to simulate a real ensemble cast.
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
  ↓  performance-director.js   direction → tempo / pitch / level / filter, split into chunks
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
* **Tempo and pitch are separated.** Kokoro's `speed` changes tempo but preserves
  pitch; Web Audio's `playbackRate` changes both. Synthesising at `tempo / pitch`
  and playing back at `pitch` cancels on tempo and compounds on pitch — which is
  what lets a direction genuinely reshape a delivery.
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
