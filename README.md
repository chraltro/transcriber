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

| Model | CPU | GPU | English and Danish | Norwegian |
| --- | --- | --- | --- | --- |
| Tiny | 41 MB | 104 to 120 MB | Stock Whisper, rough text | NB-Whisper tiny, readable |
| Base | 77 MB | 165 to 206 MB | Stock Whisper, weak on Danish | NB-Whisper base, very good |
| Small | 249 MB | 410 to 586 MB | Stock Whisper, good balance | NB-Whisper small, best for Norwegian |
| Large v3 Turbo | 1.1 GB | 564 to 759 MB | Best, especially for Danish | Stock Whisper, about as good as NB small |

For Norwegian, Tiny, Base and Small use [NB-Whisper](https://huggingface.co/NbAiLab/nb-whisper-base) from the National Library of Norway: the same architecture and download size, trained on Norwegian speech, writing Bokmål. On an NRK episode stock tiny got stuck repeating one word, while NB tiny did better than stock small and NB base came close to Large v3 Turbo at six times its speed (`tests/model-lab.mjs`).

Defaults: Large v3 Turbo with a GPU on desktop, Small on CPU, Base on phones. With WebGPU (recent Chrome or Edge on desktop) an hour-long episode takes a few minutes; on the CPU it can take about as long as the episode.

Audio is decoded a minute at a time while earlier parts are transcribed, so memory use stays flat however long the episode is. Phones kill tabs that use too much memory and reload the page, so on a phone stick to Base or Tiny.

## Deploying to GitHub Pages

It's plain static files, no build step.

The workflow in `.github/workflows/pages.yml` deploys on every push to `main`. In **Settings > Pages**, set Source to "GitHub Actions". Then open `https://<user>.github.io/transcriber/`

You can prefill a link with `?url=<podcast link>`.

## How downloads work

Browsers only let a page read servers that allow it (CORS), and the free public CORS proxies have all shut down or started requiring keys. So the app avoids needing one:

- Pocket Casts and Spotify details come from their oEmbed endpoints, which allow browser access. The episode is then looked up in Apple's podcast directory, which serves JSONP.
- Podcast audio is often wrapped in tracking redirects (podtrac, pscrb.fm and similar), and some of those block browsers even when the real host allows them. The app then tries the real audio URL embedded in the tracking chain.

Some hosts block browsers entirely (for example Anchor, now Spotify for Creators). For those, download the episode and pick the file under "More options", or deploy the included `cors-proxy-worker.js` as a free Cloudflare Worker and paste its URL there.

If the page reloads before a transcript finishes (usually the browser running out of memory), it offers to resume from where it stopped without downloading the episode again. Finished transcripts download as `.txt`, or as `.srt`/`.vtt` subtitles with timestamps.

## Testing

- `npm test`: unit tests for MP3/WAV indexing, link and feed parsing, title matching, segmentation, the streaming transcriber, subtitles and model choices. `NETWORK_TESTS=1 npm test` also checks every model file the app can request exists on Hugging Face.
- `npm run test:e2e`: loads the app in real browsers, pastes real links (Pocket Casts, NRK and a Danish show via Apple, Spotify, RSS) and waits for real Whisper output. It covers Chromium, Firefox, an iPhone profile in WebKit, WebGPU in software, a reload mid-transcript followed by resume, and memory over a long run, and checks that each transcript is in the chosen language.

Both run in GitHub Actions on every push to a `claude/**` branch that touches the app.

## Files

- `index.html`, `style.css`: the page
- `app.js`: link resolution, downloading, decoding, UI
- `worker.js`: runs Whisper off the main thread on audio streamed in from the page
- `lib/`: the logic both use, kept free of the DOM so it can be unit tested (MP3/WAV indexing, link parsing, text cleanup, splitting audio at pauses into 30 second windows, model choices, subtitles)
- `coi-sw.js`: service worker that enables multi-threaded WASM on GitHub Pages
- `cors-proxy-worker.js`: optional self-hosted proxy
