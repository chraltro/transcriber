# Design

How the app looks and moves, and why. Read this before changing anything visible.

## The job

One person's everyday podcast player, used mostly as a home-screen app on an iPhone. It also transcribes episodes, which is what it has that other players don't: for a transcribed episode it knows how loud every second is, who is speaking when, where the sponsor reads are, where the chapters begin.

## The direction: the score

Picked by the owner on 14 November 2026 from three live mock-ups (the score, a studio meter bridge, a radio dial).

The position control in the player is not a line with a thumb. It is the whole episode drawn as one strip that can be read at a glance and scrubbed on: a bar for each stretch of time, its height the loudness, its colour the voice, the sponsor read hatched, a tick where each chapter starts, a red line where the listener is. With a finger down on it, a magnified window of the part under the finger opens above, for picking an exact spot.

The mock-up it was picked from is kept beside this file's history: `tests-local/score-mockup.html` in a working copy, or ask for the page "Player directions".

## Principles

1. **Draw what is known, to scale.** Every mark stands for something the app has measured: loudness, a voice, a sponsor read, a chapter, a position. Where it has not measured, the mark is plainly absent (an even row of faint bars, no colours), never invented. A streamed episode nobody transcribed looks like one.
2. **One memorable thing.** The score is it. Everything around it stays as quiet as it is today: flat teal panels, slab headings, mono labels, low radius. No second showpiece.
3. **Motion is drawing or travel, once.** A strip draws in along its length. A sheet comes from the edge it lives at. A value moves from where it was to where it is. Nothing fades up in a stagger, pulses, breathes, bounces, or loops while idle. While an episode plays, the only thing that moves is the position.
4. **The colours already have jobs.** The speaker hues are for voices and nothing else. Red is the position and the play button and nothing else. No new colours, no colour taken from cover art.
5. **Made for a thumb.** Anything touched is at least 44 px, works one-handed, is sharp on a 3x screen, and is complete and still under reduced motion.

## Measurements

Colours, type and radius are the tokens in `style.css` (`:root`), unchanged.

| What | Value | From |
|---|---|---|
| Strip bar | 2 px wide, one every 3 px | the mock-up, judged at 390 px |
| Strip height | 64 px of bars above a 1 px baseline | the mock-up |
| Bar height | loudness, rescaled from the episode's 3rd percentile to its maximum (speech averaged over half a minute is nearly flat otherwise) | the mock-up |
| Played / not yet played | full strength / mixed 70% toward the panel behind (a mix, not opacity, so yellow does not turn olive) | the mock-up, and its builder's note |
| Voice colours | the colour the transcript side gives that speaker (`--spk-N`, N its number modulo 6), so a voice is one colour everywhere; passing voices share `--faint` | the transcript side (`hueOf` in app.js) |
| Sponsor read | a hollow box in `--faint`, hatched at 45 degrees, flat-topped, no bars inside | the mock-up |
| Chapter start | a 1 px tick, 6 px long, under the baseline | the mock-up |
| Position | a 1.5 px line in `--accent`, the full height of the strip | the mock-up |
| Magnifier | 90 s either side of the finger, one bar a second, with the chapter's name, the exact time and the window's two edge times; a small bracket on the strip shows which part it covers | the mock-up |
| No data | bars of one even height in `--faint` at 35%; ticks, sponsor box, position and magnifier as usual | principle 1 |
| Draw-in | once, when the strip first shows for an episode: left to right, 500 ms, linear | the mock-up |
| Magnifier opens / closes | 160 ms, `--ease` | the mock-up |
| Interface moves | 120 ms (a press, a switch), 200 ms (a menu, a toast), 320 ms (a sheet, a screen); `--ease` | what the app already used, made into three steps |

## What stays out

Three separate runs of a generic model, given only the brief "make a podcast player visually stunning", all proposed the same things. They are what everything else looks like, so none of them goes in unless the owner asks for one by name:

- blurred or gradient backgrounds made from the cover art, or any colour taken from it
- grain, glows, glass
- a greeting header ("Good evening")
- cards that fade and rise one after another
- a waveform that breathes or pulses with the audio, cover art that scales with playback
- line-art illustrations for empty states (headphones, moons)
- a play button that morphs, press effects that scale things down
- a cream, ember and purple palette; Fraunces with Inter

Also out, by the owner's standing rules: italics, emoji, em dashes in copy, title case, buttons that don't say what happens.

## Checking a change

`python3 slop_lint.py` (the owner's lint; "Roboto" and "JetBrains Mono" findings are this project's existing faces and are expected), then look at it at 390 and 1440 wide in both themes, then compare against "What stays out" item by item.
