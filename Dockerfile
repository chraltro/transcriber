# transcriber.demant.app: serves the app and the transcripts the GitHub workflow uploads
# (server/main.mjs). The transcribing runs on GitHub's runners (.github/workflows/shows.yml):
# the server this runs on is small and shared, so the image stays light and the build cheap
# (no ffmpeg, no speech models; server/main.mjs only needs Node).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV DATA_DIR=/data PORT=3000 NODE_ENV=production
VOLUME /data
EXPOSE 3000
# Coolify checks /healthz with curl from inside the container.
WORKDIR /app/server
CMD ["node", "main.mjs"]
