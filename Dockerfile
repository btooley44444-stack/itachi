FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    chromium \
    && pip3 install -U yt-dlp --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
RUN npm install puppeteer-core --omit=dev

COPY . .

CMD ["node", "bot.js"]
