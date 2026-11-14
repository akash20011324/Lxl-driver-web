FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN npm ci --omit=dev --prefix ./server
COPY server/ ./server/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "server/src/index.js"]
