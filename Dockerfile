FROM node:20-bookworm-slim

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    fontconfig \
    fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV RENDERER_VERSION=capcut-pro-2

EXPOSE 3000

CMD ["npm", "start"]
