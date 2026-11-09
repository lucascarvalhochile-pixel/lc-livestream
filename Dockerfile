FROM node:20-slim

# Install FFmpeg, curl, python3, yt-dlp, Pillow and numpy (for overlay PNG generation)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl python3 pip && \
    pip install --break-system-packages yt-dlp Pillow numpy && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE ${PORT:-3000}

CMD ["node", "server.js"]
