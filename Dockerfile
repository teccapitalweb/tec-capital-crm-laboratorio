FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY public ./public
COPY server ./server
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 3100
CMD ["node", "server/index.mjs"]
