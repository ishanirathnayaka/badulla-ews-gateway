FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js safe_locations.json ./
COPY artefacts ./artefacts
CMD ["node", "server.js"]