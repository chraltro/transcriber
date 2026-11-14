import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directUrl } from '../../lib/direct.js';

test('the address behind a counting service is read out of the service\'s own', () => {
  assert.equal(directUrl('https://dts.podtrac.com/redirect.mp3/traffic.megaphone.fm/GLT123.mp3?updated=17'), 'https://traffic.megaphone.fm/GLT123.mp3?updated=17');
  assert.equal(directUrl('https://www.podtrac.com/pts/redirect.mp3/media.example.org/shows/ep1.mp3'), 'https://media.example.org/shows/ep1.mp3');
  assert.equal(directUrl('https://chtbl.com/track/G8E9D1/cdn.simplecast.com/audio/a/b/ep.mp3?aid=rss_feed'), 'https://cdn.simplecast.com/audio/a/b/ep.mp3?aid=rss_feed');
  assert.equal(directUrl('https://pdst.fm/e/stitcher.simplecastaudio.com/x/episodes/y/audio/128/default.mp3'), 'https://stitcher.simplecastaudio.com/x/episodes/y/audio/128/default.mp3');
  assert.equal(directUrl('https://op3.dev/e,pg=1c2d3e/media.transistor.fm/abc/def.mp3'), 'https://media.transistor.fm/abc/def.mp3');
  assert.equal(directUrl('https://mgln.ai/e/35/audio.buzzsprout.com/123.m4a'), 'https://audio.buzzsprout.com/123.m4a');
  assert.equal(directUrl('https://growx.podkite.com/https/A1B2/anchor.fm/s/1/podcast/play/2/file.mp3'), 'https://anchor.fm/s/1/podcast/play/2/file.mp3');
});

test('services stacked on one another are all taken off', () => {
  assert.equal(
    directUrl('https://pdst.fm/e/chtbl.com/track/ABC/dts.podtrac.com/redirect.mp3/pscrb.fm/rss/p/traffic.megaphone.fm/VMP1.mp3?updated=1'),
    'https://traffic.megaphone.fm/VMP1.mp3?updated=1',
  );
});

test('an address with no counting service in it is left as it is', () => {
  for (const url of [
    'https://traffic.megaphone.fm/GLT123.mp3',
    'https://example.org/audio/chtbl.com/file.mp3', // (the service's name in someone else's path)
    'http://localhost:8080/audio/harbour/3.wav',
    'https://dts.podtrac.com/redirect.mp3', // nothing behind it to go to
    'https://play.podtrac.com/abc/episode.mp3', // the file is the service's own
    'not an address',
    '',
  ]) assert.equal(directUrl(url), url);
  assert.equal(directUrl(null), '');
});
