# Podcast Transcriber

A podcast player for one person that also writes the transcript, made to be used as a home-screen web app on an iPhone. It opens on **Listen**: the shows you follow, what is new from them, and the player.

The transcriber is the **Transcribe** section (`#/transcribe`): paste a podcast link, get the full transcript with a copy button. It runs OpenAI's Whisper in your browser through [Transformers.js](https://github.com/huggingface/transformers.js), with no API key or account, and audio you transcribe there never leaves your machine. Shows and positions go to your own server when there is one.

## Listening

- **Following shows**: search Apple's podcast directory by name, or paste an Apple Podcasts link or feed address. OPML files import and export.
- **New episodes** across followed shows, filtered by **Not played** or **All**, and **Carry on** for episodes started and not finished.
- **A show's page**: its episodes, a search, and Play the latest.
- **Up next**: the queue. **Play next** puts an episode first, and when one ends the next starts.
- **The player**: back 15 and forward 30 seconds (changeable in Settings), speed from 0.8x to 3x with an optional speed per show, and a sleep timer. Each episode's position is remembered, and after a pause it picks up a few seconds earlier (up to 25 after a day). Keys: `k` or space plays and pauses, `j` goes back, `l` forward.
- **Shorten pauses**: pick the longest pause to leave alone (0.5, 0.8, 1.2 or 2 seconds) and anything longer is cut down to that, so the dead air of a call's delay goes and the pauses people make on purpose stay. Where the audio goes quiet is found from the audio itself (`lib/quiet.js`): by the transcribing for episodes the server has, on the device for episodes saved for offline. A streamed episode has to be saved first; the player offers to.
- **Episode notes** come from the feed, and times in them (`12:34`) start the episode there.
- **Save for offline** keeps an episode on the device, listed under Up next.

## On an iPhone

- In Safari, tap Share, then Add to Home Screen. It keeps playing with the screen locked.
- The lock screen and Control Center get play and pause, back and forward, and scrubbing through the Media Session API. Settings > Lock screen shows previous and next instead.
- From the home screen the page runs under the status bar, with a dark strip behind it in either theme.
- The home-screen app keeps its storage apart from Safari: link it by pasting the link from Settings on a linked device.

## Skipping ads

Ads are found from an episode's transcript (`lib/breaks.js`, built on `lib/pitch.js`). When a transcript is uploaded, its ad breaks are stored in the server's library index.

- Breaks are marked on the position slider and skipped as they come up, with an **Undo**.
- Skipping happens only when the copy being played is the one the transcript was made from (the server's copy).
- Going back 15 seconds just after an ad lands 15 seconds before it. On the lock screen, the forward button inside an ad leaves the ad.

It is wording-based and errs towards leaving an ad in: what isn't clearly a sponsor read is never skipped.

## One library on every device

The server keeps shows, positions, the queue and settings (`server/pod.mjs`, in `/data/pod`), with no accounts:

- Until someone does, the site offers **Start the library on this device**: that device makes a random key the library's. Other devices join with the link or QR code under Settings. Opening the page alone claims nothing.
- The key goes in a header on every request. The cookie set when a device joins only gets that device its key back (a home-screen app that inherits Safari's cookies).
- Setting `SYNC_KEY` on the server fixes the key instead.
- Records merge one by one, the last change winning (`lib/podstate.js`).

Feeds are read on the server, every `POLL_MINUTES` (30 by default) and when the app asks for what is new.

A static copy (GitHub Pages) has no server: everything stays in the browser, and feeds are read directly where their hosts allow it.

## Transcripts on the server

A followed show's page has **Transcribe new episodes** and **And the last** N, which goes back for older ones. Any episode has **Transcribe on the server**.

The work runs on GitHub's runners (`.github/workflows/shows.yml`, `server/ci.mjs`, `server/plan.mjs`). Each run reads `/api/pod/transcribe` (which answers the workflow's GitHub token or the library's key, nobody else) and does new episodes first, then single requests, then the backfill. The five shows in `server/shows.mjs` are followed from the start, with Transcribe new episodes on.

## Offline

The service worker (`coi-sw.js`) keeps the app's own files, so the app starts without a connection. Episodes saved for offline play without one.

## Supported links

- **Apple Podcasts**: episode links (`...?i=1000...`) go straight to that episode, show links list the episodes
- **Pocket Casts**: episode links (`pca.st/episode/...`, `pca.st/<code>`) and `pocketcasts.com` show links
- **Spotify**: finds the same episode through Apple's podcast directory (Spotify exclusives can't be transcribed)
- **RSS feeds**: pick an episode from the list
- **Episode web pages**: finds the audio on the page, or its RSS feed
- **Direct audio links** (`.mp3`, `.m4a`, ...)
- **Local files**: "open an audio file" under the link field

`?url=<podcast link>` opens the Transcribe section with that link filled in.

## Models

Pick the size under "Model". Sizes are what your browser downloads (once, then cached):

| Model | CPU | GPU | English and Danish | Norwegian |
| --- | --- | --- | --- | --- |
| Tiny | 41 MB | 104 to 120 MB | Stock Whisper, rough text | NB-Whisper tiny, readable |
| Base | 77 MB | 165 to 206 MB | Stock Whisper, weak on Danish | NB-Whisper base, very good |
| Small | 249 MB | 410 to 586 MB | Stock Whisper, good balance | NB-Whisper small, best for Norwegian |
| Large v3 Turbo | 1.1 GB | 564 to 759 MB | Best, especially for Danish | Stock Whisper, about as good as NB small |

For Norwegian, Tiny, Base and Small use [NB-Whisper](https://huggingface.co/NbAiLab/nb-whisper-base) from the National Library of Norway: the same architecture and download size, trained on Norwegian speech, writing Bokmål. On an NRK episode stock tiny got stuck repeating one word, while NB tiny did better than stock small and NB base came close to Large v3 Turbo at six times its speed (`tests/model-lab.mjs`).

Defaults: Large v3 Turbo with a GPU on desktop, Small on CPU, Base on phones. With WebGPU (recent Chrome or Edge on desktop) an hour-long episode takes a few minutes; on the CPU it can take about as long as the episode.

Audio is decoded a minute at a time while earlier parts are transcribed, so memory use stays flat however long the episode is. Phones kill tabs that use too much memory and reload the page, so on a phone stick to Base or Tiny.

## Clean up audio

Switch the start page to **Clean up audio** (or press **Clean up audio** on an open transcript) to fix how an episode sounds instead of transcribing it. Everything runs in the browser at 44.1 kHz; `?mode=clean` opens the page in that mode.

- **It listens first.** One pass over the episode (`lib/enhance/analyze.js`) finds the voices, by the transcript's speakers when there is one, otherwise by how they sound (mostly where a call or codec cuts the treble off), and measures what is wrong with each: the cut-off, dropouts (holes of near silence inside speech), how often a noise gate shuts, the background level, mains hum. That gives each voice suggested settings and finds its worst 20 seconds to preview first.
- **Every voice gets its own chain** (`lib/enhance/chain.js`, `modules.js`), crossfaded where the voice changes: rumble filter, hum removal, mouth-click repair, dropout repair (holes filled from both sides, which a recording allows and a live call can't), noise reduction (from a noise profile of that voice's pauses), room-echo reduction, restored highs (spectral band replication above the cut-off), de-esser, tone, compressor. Then the whole episode goes through a leveler (to a loudness target in LUFS, measured as BS.1770 does), room tone under dead silence, and a limiter.
- **A/B preview**: any 20 seconds, original against cleaned, re-rendered as a control moves, level-matched so the louder one doesn't win for being louder. **B** switches.
- **Export** renders the whole episode with the same code as the preview (they match sample for sample: `tests/unit/enhance-modules.test.mjs`) to MP3 (lamejs, LGPL, in `lib/vendor/`) or WAV.
- **Regenerate on the server** (only on transcriber.demant.app): stretches of a voice are rebuilt with [Resemble Enhance](https://huggingface.co/ResembleAI/resemble-enhance), a speech model too heavy for a browser, on GitHub's runners (`.github/workflows/enhance.yml`, `server/regen.mjs`, `server/regen/regen.py`). The result is the whole episode with those voices rebuilt and everything else untouched; switching **Use the regenerated voice** on makes it that voice's input to its chain. Jobs are queued on the server (`server/enhance.mjs`); the workflow looks every ten minutes, or at once if the server has a GitHub token in `GH_DISPATCH_TOKEN` (actions: write on this repository). Up to 80 minutes of voice per job, which takes about 3.5 times as long on a runner. Set `ENHANCE_KEY` on the server to require a key for queueing (the page asks for it once); without it anyone can queue jobs, three at a time, results capped at 1.5 GB on disk.

## Deploying to GitHub Pages

It's plain static files, no build step.

The workflow in `.github/workflows/pages.yml` deploys on every push to `main`. In **Settings > Pages**, set Source to "GitHub Actions". Then open `https://<user>.github.io/transcriber/`

## How downloads work

Browsers only let a page read servers that allow it (CORS), and the free public CORS proxies have all shut down or started requiring keys. So the app avoids needing one:

- Pocket Casts and Spotify details come from their oEmbed endpoints, which allow browser access. The episode is then looked up in Apple's podcast directory, which serves JSONP.
- Podcast audio is often wrapped in tracking redirects (podtrac, pscrb.fm and similar), and some of those block browsers even when the real host allows them. The app then tries the real audio URL embedded in the tracking chain.
- On a linked device, the server fetches audio whose host turns pages away.

Some hosts block browsers entirely (for example Anchor, now Spotify for Creators). Without a server, open a downloaded copy, or deploy the included `cors-proxy-worker.js` as a free Cloudflare Worker and paste its URL under "CORS proxy".

## Reading and listening

- The transcript comes in paragraphs. Whisper works in 30 second windows, and where a window was cut mid-sentence the pieces are joined again, so copied text reads naturally.
- Click any passage to hear it from there: the playing passage is highlighted and followed. Playback uses the copy that was transcribed, so dynamically inserted ads can't shift it out of sync.
- The episode's waveform draws itself while the audio is decoded and lights up as it is transcribed. Afterwards it is a scrubber.
- Refine on request: when a transcript is done (or reopened from the library), pick a bigger model and refine the whole thing, or select a badly transcribed passage and refine just that. The better text replaces the old window by window, and the library copy is updated.
- Search inside the transcript (press `/`), toggle timestamps, copy, or export as `.txt`, `.srt` or `.vtt`. On phones, Save opens the share sheet.
- Transcripts made in the browser are kept in this browser (IndexedDB) under Recent transcripts and are not uploaded.
- If the page reloads before a transcript finishes (usually the browser running out of memory), it offers to resume from where it stopped without downloading the episode again.
- Drop an audio file anywhere on the page, or pick one. Title, show and cover art are read from the file's ID3 tag.

## Testing

- `npm test`: unit tests for MP3/WAV indexing, ID3 tags, link and feed parsing, title matching, paragraphs, waveform levels, segmentation, the streaming transcriber, subtitles and model choices, feeds, ad breaks, the state document, the server's API and the workflow plan. `NETWORK_TESTS=1 npm test` also checks every model file the app can request exists on Hugging Face.
- `npm run test:e2e`: loads the app in real browsers, pastes real links (Pocket Casts, NRK and a Danish show via Apple, Spotify, RSS) and waits for real Whisper output. It covers Chromium, Firefox, an iPhone profile in WebKit, WebGPU in software, a reload mid-transcript followed by resume, and memory over a long run, and checks that each transcript is in the chosen language.
- `node tests/pod.mjs`: the podcast side end to end in a real browser, against the real server and a stand-in podcast host (`tests/pod-world.mjs`).

Both `npm` runs happen in GitHub Actions on every push to a `claude/**` branch that touches the app.

## Files

- `index.html`, `style.css`: the page. Fonts (Newsreader, Geist, Geist Mono; SIL Open Font License) are self-hosted in `fonts/`
- `app.js`: link resolution, downloading, decoding, UI
- `worker.js`: runs Whisper off the main thread on audio streamed in from the page
- `enhance-worker.js`: the clean-up's analysis, previews and export, off the main thread
- `lib/enhance/`: the clean-up itself (DSP, modules, analysis, encoding); `ui/studio.js` is its page
- `lib/`: the logic both use, kept free of the DOM so it can be unit tested (MP3/WAV indexing, ID3 tags, link parsing, text cleanup, paragraphs, waveform levels, splitting audio at pauses into 30 second windows, model choices, subtitles)
- `lib/feed.js`: podcast feeds and OPML
- `lib/breaks.js`: ad breaks from a transcript
- `lib/podstate.js`: the library document and how copies merge
- `lib/playback.js`: where to resume, which ad to skip
- `ui/pod.js`: the Listen, Up next and Settings screens
- `ui/podstore.js`: the library in the page, synced with the server
- `ui/player.js`: playback, the queue, Media Session, ad skipping
- `ui/playerui.js`: the player bar and the sheet it opens into
- `ui/downloads.js`: episodes saved for offline
- `ui/dom.js`: DOM helpers
- `ui/`: also the waveform canvas and the library of recent transcripts
- `server/pod.mjs`: the library and feeds on the server (API listed at the top)
- `server/plan.mjs`: what the shows workflow transcribes, in order
- `manifest.webmanifest` and `icon-*.png`: the home-screen app
- `lib/vendor/qrcode.mjs`: QR codes for linking a device (qrcode-generator, MIT)
- `coi-sw.js`: service worker that enables multi-threaded WASM on GitHub Pages and keeps the app's files offline
- `cors-proxy-worker.js`: optional self-hosted proxy
