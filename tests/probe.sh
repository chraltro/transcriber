#!/usr/bin/env bash
# Shows what podcast hosts and proxies actually return to a browser-like request.
set -u
EP_ID="662e3967-b4b0-4d36-84d1-d0d8b49eb03b"
EP="https://pca.st/episode/$EP_ID"
ORIGIN="https://chraltro.github.io"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
section() { echo; echo "================ $* ================"; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

curl -sSL -A "$UA" -o /tmp/pc.html "$EP"
section "context around the episode uuid in the page"
python3 - <<'PY'
import re
h=open('/tmp/pc.html',encoding='utf-8',errors='replace').read()
ep="662e3967-b4b0-4d36-84d1-d0d8b49eb03b"
for m in list(re.finditer(ep,h))[:6]:
    print('...', h[max(0,m.start()-400):m.end()+600].replace('\n',' '), '...\n')
i=h.find('window.__')
print('window.__ at', i, h[i:i+300] if i>=0 else '')
PY

AUDIO=$(python3 - <<'PY'
import re,json
h=open('/tmp/pc.html',encoding='utf-8',errors='replace').read()
ep="662e3967-b4b0-4d36-84d1-d0d8b49eb03b"
i=h.find('"uuid":"'+ep) if '"uuid":"'+ep in h else h.find('\\"uuid\\":\\"'+ep)
seg=h[i:i+3000]
m=re.search(r'\\?"url\\?":\\?"(https?:[^"\\]+(?:\\\\u0026[^"\\]+)*)',seg)
print(m.group(1).replace('\\u0026','&') if m else '')
PY
)
section "audio url for episode: $AUDIO"

section "CORS along the audio redirect chain"
[ -n "$AUDIO" ] && curl -sSIL -m 30 -A "$UA" -H "Origin: $ORIGIN" -H "Range: bytes=0-1" "$AUDIO" | grep -iE "^(HTTP|location|access-control-allow-origin|content-type|content-range)"

section "iTunes lookup for the show (feed url)"
FEED=$(curl -sS "https://itunes.apple.com/search?term=pod+save+the+world&entity=podcast&limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin)['results'][0]['feedUrl'])")
echo "feed: $FEED"
curl -sSI -m 20 -A "$UA" -H "Origin: $ORIGIN" "$FEED" | grep -iE "^(HTTP|access-control-allow-origin|content-type)"

try_proxy() { # name template(with {u}) target
  local url="${2//\{u\}/$(enc "$3")}"
  local url_raw="${2//\{r\}/$3}"; [ "$url_raw" != "$2" ] && url="$url_raw"
  local out; out=$(curl -sS -m 25 -A "$UA" -H "Origin: $ORIGIN" -H "X-Requested-With: XMLHttpRequest" -D /tmp/h -o /tmp/b -w "%{http_code}" "$url" 2>&1)
  local acao; acao=$(grep -i "^access-control-allow-origin" /tmp/h | tr -d '\r' | head -1)
  printf "%-28s %-6s %-9s bytes=%-8s %s | %s\n" "$1" "$4" "$out" "$(wc -c </tmp/b)" "$acao" "$(head -c 90 /tmp/b | tr '\n' ' ')"
}
section "keyless proxies (page / feed / audio)"
for spec in \
  "corsproxy.io|https://corsproxy.io/?url={u}" \
  "allorigins raw|https://api.allorigins.win/raw?url={u}" \
  "allorigins get|https://api.allorigins.win/get?url={u}" \
  "codetabs|https://api.codetabs.com/v1/proxy/?quest={u}" \
  "cors.lol|https://api.cors.lol/?url={u}" \
  "cors.eu.org|https://cors.eu.org/{r}" \
  "thingproxy|https://thingproxy.freeboard.io/fetch/{r}" \
  "corsproxy.org|https://corsproxy.org/?url={u}" \
  "everyorigin|https://everyorigin.jwvbremen.nl/api/get?url={u}" \
  "whateverorigin|https://whateverorigin.org/get?url={u}" \
  "corsfix|https://proxy.corsfix.com/?{r}" \
  "cors-anywhere heroku|https://cors-anywhere.herokuapp.com/{r}" \
  "yacdn|https://yacdn.org/proxy/{r}" \
  "htmldriven|https://cors-proxy.htmldriven.com/?url={u}" \
  "jina reader|https://r.jina.ai/{r}" \
  "cors.sh|https://proxy.cors.sh/{r}" \
  "crossorigin.me|https://crossorigin.me/{r}" \
  "gobetween|https://gobetween.oklabs.org/{r}" \
  "cloudflare-cors-anywhere|https://test.cors.workers.dev/?{r}" ; do
  name="${spec%%|*}"; tmpl="${spec#*|}"
  try_proxy "$name" "$tmpl" "$EP" page
  try_proxy "$name" "$tmpl" "$FEED" feed
done
