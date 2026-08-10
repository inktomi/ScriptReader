# ScriptReader

ScriptReader is a powerful, locally-run web application designed to help screenwriters and filmmakers experience their scripts through dynamic, multi-voice "table reads." 

By leveraging advanced in-browser neural Text-to-Speech (TTS), ScriptReader can parse a script, assign distinct voices to each character, and read the dialogue aloud—all without sending your private scripts to the cloud or requiring expensive API keys.

## Key Features

* **Multi-Voice Table Reads**: Assign unique voices to different characters in your screenplay. The application intelligently switches between voices during dialogue scenes to simulate a real ensemble cast.
* **Format Support**: Upload scripts in standard industry formats, including **Fountain** text files and **PDFs**.
* **100% Local Processing**: ScriptReader runs entirely in your browser. It uses WebAssembly (WASM) and WebGPU via Transformers.js to execute neural TTS models (like Kokoro) directly on your device. Your data never leaves your computer.
* **Background Pre-Rendering**: A dedicated Web Worker intelligently looks ahead in your script and pre-renders upcoming lines of dialogue in the background. This ensures completely seamless, lag-free playback during dense, fast-paced dialogue scenes.
* **Teleprompter UI**: Follow along with the audio playback via a clean, auto-scrolling teleprompter interface that highlights the current active line.
* **Emotion & Nuance Support**: Adjust speech speed, pitch, and emotional nuances to get the perfect delivery for each character.

## How It Works

1. **Upload a Script**: Drag and drop a `.fountain` or `.pdf` file.
2. **Assign Voices**: Open the Cast Panel to map characters to specific synthetic voice profiles. 
3. **Play**: Hit play on the transport bar, and the application will orchestrate the table read.

## Technical Stack

* **Frontend**: Vanilla JavaScript (ESModules) and CSS, bundled with Vite.
* **Audio Engine**: Web Audio API combined with `kokoro-js` (a port of the Kokoro TTS model). 
* **Neural Inference**: Handled via `@huggingface/transformers` running in a dedicated Web Worker to prevent UI blocking.
* **Parsing**: Custom Fountain parsing and PDF text extraction.

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
