# Podcast Transcriber

Paste a podcast link, get the full transcript with a copy button. Supports English, Norwegian and Danish.

Everything runs in your browser using OpenAI's Whisper through [Transformers.js](https://github.com/huggingface/transformers.js). No API key, no backend, no account. The audio never leaves your machine.

## Supported links

- **Apple Podcasts**: episode links (`...?i=1000...`) go straight to that episode, show links list the episodes
- **Pocket Casts**: episode links (`pca.st/episode/...`, `pca.st/<code>`) and `pocketcasts.com` show links
- **Spotify**: finds the same episode through Apple's podcast directory (Spotify exclusives can't be transcribed)
- **RSS feeds**: pick an episode from the list
- **Episode web pages**: finds the audio on the page, or its RSS feed
- **Direct audio links** (`.mp3`, `.m4a`, ...)
- **Local files**: under "More options"

## Models

Pick the size under "Model size". Sizes are what your browser downloads (once, then cached):

| Model | CPU | GPU | Notes |
| --- | --- | --- | --- |
| Tiny | 41 MB | 104 to 120 MB | Fastest, rough text |
| Base | 77 MB | 165 to 206 MB | Weak on Norwegian and Danish |
| Small | 249 MB | 410 to 586 MB | Good balance |
| Large v3 Turbo | 1.1 GB | 564 to 759 MB | Best by far for Norwegian and Danish |

Defaults: Large v3 Turbo with a GPU on desktop, Small on CPU, Base on phones. With WebGPU (recent Chrome or Edge on desktop) an hour-long episode takes a few minutes; on the CPU it can take about as long as the episode.

Audio is decoded two minutes at a time while earlier parts are transcribed, so memory use stays flat however long the episode is. Phones kill tabs that use too much memory and reload the page, so on a phone stick to Base or Tiny.

## Deploying to GitHub Pages

It's plain static files, no build step.

The workflow in `.github/workflows/pages.yml` deploys on every push to `main`. In **Settings > Pages**, set Source to "GitHub Actions". Then open `https://<user>.github.io/transcriber/`

You can prefill a link with `?url=<podcast link>`.

## How downloads work

Browsers only let a page read servers that allow it (CORS), and the free public CORS proxies have all shut down or started requiring keys. So the app avoids needing one:

- Pocket Casts and Spotify details come from their oEmbed endpoints, which allow browser access. The episode is then looked up in Apple's podcast directory, which serves JSONP.
- Podcast audio is often wrapped in tracking redirects (podtrac, pscrb.fm and similar), and some of those block browsers even when the real host allows them. The app then tries the real audio URL embedded in the tracking chain.

Some hosts block browsers entirely (for example Anchor, now Spotify for Creators). For those, download the episode and pick the file under "More options", or deploy the included `cors-proxy-worker.js` as a free Cloudflare Worker and paste its URL there.

## Testing

`tests/e2e.mjs` loads the app in headless Chromium, pastes real links (Pocket Casts, NRK via Apple, a Danish Omny show, Spotify, RSS) and waits for real Whisper output. It runs in GitHub Actions on every push to a `claude/**` branch that touches the app.

## Files

- `index.html`, `style.css`: the page
- `app.js`: link resolution, downloading, decoding, UI
- `worker.js`: runs Whisper off the main thread on audio streamed in from the page, split at pauses into 30 second windows
- `coi-sw.js`: service worker that enables multi-threaded WASM on GitHub Pages
- `cors-proxy-worker.js`: optional self-hosted proxy
