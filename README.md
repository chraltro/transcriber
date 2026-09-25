# Podcast Transcriber

Paste a podcast link, get the full transcript with a copy button. Supports English, Norwegian and Danish.

Everything runs in your browser using OpenAI's Whisper through [Transformers.js](https://github.com/huggingface/transformers.js). No API key, no backend, no account. The audio never leaves your machine.

## Supported links

- **Apple Podcasts**: episode links (`...?i=1000...`) go straight to that episode, show links list the episodes
- **Spotify**: finds the same episode in the podcast's public feed (Spotify exclusives can't be transcribed)
- **RSS feeds**: pick an episode from the list
- **Episode web pages**: finds the audio on the page, or its RSS feed
- **Direct audio links** (`.mp3`, `.m4a`, ...)
- **Local files**: under "More options"

## Models

| Option | Model | Notes |
| --- | --- | --- |
| Fast | Whisper Base | Small download, weak on Norwegian and Danish |
| Balanced | Whisper Small | Default without WebGPU |
| Best | Whisper Large v3 Turbo | Default with WebGPU. By far the best for Norwegian and Danish |

The model downloads once and is cached by the browser. With WebGPU (recent Chrome or Edge on desktop), an hour-long episode takes a few minutes. Without WebGPU it runs on the CPU, which can take about as long as the episode itself.

## Deploying to GitHub Pages

It's plain static files, no build step.

1. Merge to `main`
2. Repo **Settings > Pages > Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`
3. Open `https://<user>.github.io/transcriber/`

You can prefill a link with `?url=<podcast link>`.

## How downloads work

Browsers only let a page download audio from servers that allow it (CORS). The app tries the link directly first, then a few public CORS proxies. If a host blocks all of them, you can deploy the included `cors-proxy-worker.js` as a free Cloudflare Worker and paste its URL under "More options", or download the episode yourself and pick the file.

## Files

- `index.html`, `style.css`: the page
- `app.js`: link resolution, downloading, decoding, UI
- `worker.js`: runs Whisper off the main thread, splits audio at pauses into 30 second windows
- `coi-sw.js`: service worker that enables multi-threaded WASM on GitHub Pages
- `cors-proxy-worker.js`: optional self-hosted proxy
