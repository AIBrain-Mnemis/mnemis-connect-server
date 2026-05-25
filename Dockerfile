FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc --noEmit

FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && apk del python3 make g++

COPY src/ ./src/
COPY migrations/ ./migrations/

ENV PORT=3000
ENV DB_PATH=/data/rtc.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "--import", "tsx", "src/server.ts"]
