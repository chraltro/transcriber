# transcriber.demant.app: the app, plus a server that transcribes new episodes of followed
# shows as they come out (server/main.mjs). Transcripts and downloaded models live in /data.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY . .
ENV DATA_DIR=/data PORT=3000 NODE_ENV=production
VOLUME /data
EXPOSE 3000
WORKDIR /app/server
CMD ["node", "main.mjs"]
