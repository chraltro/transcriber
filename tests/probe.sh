#!/usr/bin/env bash
# Shows what podcast hosts and proxies actually return to a browser-like request.
set -u
EP="https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b"
ORIGIN="https://chraltro.github.io"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

section() { echo; echo "================ $* ================"; }

section "pca.st episode page: redirects + headers"
curl -sSL -A "$UA" -H "Origin: $ORIGIN" -D - -o /tmp/pc.html -w "final=%{url_effective} code=%{http_code}\n" "$EP" | grep -iE "^(HTTP|location|access-control|content-type)|final="
echo "bytes: $(wc -c < /tmp/pc.html)"
section "pca.st page: meta tags"
grep -oiE '<meta[^>]+(og:|twitter:|name="description")[^>]*>' /tmp/pc.html | head -20
section "pca.st page: audio-ish URLs"
grep -oiE 'https?:[^"'"'"' <>]+\.(mp3|m4a|aac|ogg)[^"'"'"' <>]*' /tmp/pc.html | sort -u | head
section "pca.st page: UUIDs"
grep -oiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/pc.html | sort | uniq -c | head
section "pca.st page: scripts / data blobs"
grep -oiE '<script[^>]*(src|id)="[^"]*"' /tmp/pc.html | head
grep -oE '"(url|audio|podcastUuid|podcast_uuid|episodeUuid|uuid|feed|title)":"[^"]{0,150}"' /tmp/pc.html | sort -u | head -30
section "pca.st page: first 3000 chars of body text"
sed -e 's/<[^>]*>/ /g' /tmp/pc.html | tr -s ' \n' | head -c 3000; echo

for P in "https://corsproxy.io/?url=" "https://api.allorigins.win/raw?url=" "https://api.codetabs.com/v1/proxy/?quest="; do
  section "proxy $P"
  ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$EP")
  curl -sS -m 25 -A "$UA" -H "Origin: $ORIGIN" -D - -o /tmp/p.out -w "code=%{http_code}\n" "$P$ENC" | grep -iE "^(HTTP|access-control-allow-origin|content-type)|code="
  echo "bytes: $(wc -c < /tmp/p.out)"; head -c 300 /tmp/p.out; echo
done

section "Pocket Casts APIs (CORS?)"
for U in \
  "https://podcast-api.pocketcasts.com/episode/show_notes/662e3967-b4b0-4d36-84d1-d0d8b49eb03b" \
  "https://podcast-api.pocketcasts.com/mobile/show_notes/full/662e3967-b4b0-4d36-84d1-d0d8b49eb03b" \
  "https://sharing.pocketcasts.com/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b" \
  "https://pocketcasts.com/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b" ; do
  echo "--- $U"
  curl -sS -m 20 -A "$UA" -H "Origin: $ORIGIN" -D - -o /tmp/a.out -w "code=%{http_code}\n" "$U" | grep -iE "^(HTTP|location|access-control-allow-origin|content-type)|code="
  head -c 400 /tmp/a.out; echo
done
