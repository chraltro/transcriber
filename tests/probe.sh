#!/usr/bin/env bash
# Checks which podcast endpoints a browser can read directly (CORS), with no proxy.
set -u
EP_ID="662e3967-b4b0-4d36-84d1-d0d8b49eb03b"
ORIGIN="https://chraltro.github.io"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
section() { echo; echo "================ $* ================"; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
acao() { # url -> status + ACAO for GET
  curl -sS -m 15 -A "$UA" -H "Origin: $ORIGIN" -o /tmp/body -D /tmp/hdr -w "%{http_code}" "$1" 2>&1
  echo " acao=[$(grep -i '^access-control-allow-origin' /tmp/hdr | tr -d '\r' | cut -d' ' -f2-)] type=[$(grep -i '^content-type' /tmp/hdr | tr -d '\r' | cut -d' ' -f2-)]"
}
chain() { # follow redirects manually, print CORS per hop (a browser needs ACAO on every hop)
  local u="$1" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS -m 15 -A "$UA" -H "Origin: $ORIGIN" -H "Range: bytes=0-1" -o /dev/null -D /tmp/h "$u" 2>&1
    local code; code=$(head -1 /tmp/h | awk '{print $2}')
    local a; a=$(grep -i '^access-control-allow-origin' /tmp/h | tr -d '\r' | cut -d' ' -f2-)
    local loc; loc=$(grep -i '^location' /tmp/h | tr -d '\r' | cut -d' ' -f2-)
    echo "   hop$i $code acao=[$a] $(echo "$u" | cut -c1-110)"
    [ -z "$loc" ] && break
    case "$loc" in http*) u="$loc";; /*) u="$(echo "$u" | cut -d/ -f1-3)$loc";; *) u="$loc";; esac
  done
}

section "Pocket Casts oEmbed"
acao "https://pca.st/oembed.json?url=$(enc "https://pca.st/episode/$EP_ID")"; head -c 600 /tmp/body; echo
acao "https://pca.st/oembed.json?url=$(enc "https://pocketcasts.com/podcast/pod-save-the-world/c9f2aff0-c93a-0134-10da-25324e2a541d/xis-just-not-that-into-you/$EP_ID")"; head -c 600 /tmp/body; echo
acao "https://pocketcasts.com/oembed.json?url=$(enc "https://pca.st/episode/$EP_ID")"; head -c 300 /tmp/body; echo

section "Pocket Casts page: download link"
curl -sSL -m 20 -A "$UA" -o /tmp/pc.html "https://pca.st/episode/$EP_ID"
python3 - <<'PY'
import re
h=open('/tmp/pc.html',encoding='utf-8',errors='replace').read()
i=h.find('img-btn-download-file')
j=h.rfind('<a',0,i)
print(h[j:i+60])
PY

section "Per show: feed CORS, latest episode audio chain CORS"
for term in "pod save the world" "Loket NRK" "Abels tårn" "Genstart DR" "Millionærklubben" "The Daily" "Huberman Lab" "Lex Fridman"; do
  echo; echo "### $term"
  curl -sS -m 15 "https://itunes.apple.com/search?term=$(enc "$term")&entity=podcast&limit=1&country=no" > /tmp/s.json
  read -r CID FEED NAME < <(python3 -c "import json;r=json.load(open('/tmp/s.json'))['results'];print(r[0]['collectionId'],r[0].get('feedUrl',''),r[0]['collectionName'].replace(' ','_')) if r else print('- - -')")
  echo " show=$NAME feed=$FEED"
  [ "$CID" = "-" ] && continue
  echo -n " feed: "; acao "$FEED"
  curl -sS -m 15 "https://itunes.apple.com/lookup?id=$CID&entity=podcastEpisode&limit=3" > /tmp/l.json
  AUD=$(python3 -c "import json;r=[x for x in json.load(open('/tmp/l.json'))['results'] if x.get('episodeUrl')];print(r[0]['episodeUrl'] if r else '')")
  echo " episodeUrl=$AUD"
  [ -n "$AUD" ] && chain "$AUD"
done

section "Pod Save the World: find the Xi episode in iTunes"
curl -sS -m 15 "https://itunes.apple.com/search?term=$(enc "Xi’s Just Not That Into You pod save the world")&entity=podcastEpisode&limit=5" | python3 -c "import json,sys;[print(' ',x.get('trackName'),'|',x.get('collectionName'),'|',x.get('episodeUrl')) for x in json.load(sys.stdin)['results']]"
