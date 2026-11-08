FROM node:20-slim

# Install FFmpeg and curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Railway sets PORT automatically
EXPOSE ${PORT:-3000}

CMD ["node", "server.js"]
