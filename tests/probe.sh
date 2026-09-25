#!/usr/bin/env bash
set -u
ORIGIN="https://chraltro.github.io"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
show() { echo "--- $1"; shift; curl -sS -m 15 -A "$UA" -o /tmp/b -D /tmp/h -w "code=%{http_code} final=%{url_effective}\n" "$@" 2>&1 | cut -c1-200; grep -iE '^(access-control-allow-origin|content-type|location)' /tmp/h | tr -d '\r'; head -c 300 /tmp/b | tr '\n' ' '; echo; }

echo "=== DR asset variants"
DR=$(curl -sS -m 15 "https://itunes.apple.com/lookup?id=$(curl -sS "https://itunes.apple.com/search?term=Genstart&entity=podcast&limit=1&country=dk" | python3 -c "import json,sys;print(json.load(sys.stdin)['results'][0]['collectionId'])")&entity=podcastEpisode&limit=2" | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['results'] if x.get('episodeUrl')][0]['episodeUrl'])")
echo "$DR"
show "DR plain" "$DR"
show "DR origin" -H "Origin: $ORIGIN" "$DR"
show "DR origin+range" -H "Origin: $ORIGIN" -H "Range: bytes=0-1" "$DR"
show "DR origin follow" -L -H "Origin: $ORIGIN" -r 0-1 "$DR"

echo "=== Spotify oEmbed"
show "show oembed" -H "Origin: $ORIGIN" "https://open.spotify.com/oembed?url=$(enc https://open.spotify.com/show/3IM0lmZxpFAY7CwMuv9H4g)"
show "spotify page" -H "Origin: $ORIGIN" "https://open.spotify.com/show/3IM0lmZxpFAY7CwMuv9H4g"

echo "=== Pocket Casts oEmbed for podcast links"
show "pca podcast" -H "Origin: $ORIGIN" "https://pca.st/oembed.json?url=$(enc https://pca.st/podcast/c9f2aff0-c93a-0134-10da-25324e2a541d)"
show "pca short" -H "Origin: $ORIGIN" "https://pca.st/oembed.json?url=$(enc https://pca.st/okm7xj7g)"

echo "=== anchor final without range"
show "anchor cf" -H "Origin: $ORIGIN" "https://d3ctxlq1ktw2nl.cloudfront.net/staging/2026-8-4/b8bb1328-396b-7cb4-92a5-a2d12f8b6f65.mp3"
show "anchor play" -H "Origin: $ORIGIN" "https://anchor.fm/s/6edccfe4/podcast/play/125214471/https%3A%2F%2Fd3ctxlq1ktw2nl.cloudfront.net%2Fstaging%2F2026-8-4%2Fb8bb1328-396b-7cb4-92a5-a2d12f8b6f65.mp3"

echo "=== iTunes JSONP response shape"
curl -sS -m 15 "https://itunes.apple.com/search?term=abels+taarn&entity=podcast&limit=1&callback=cb" | head -c 200; echo
