FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build
RUN npm prune --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]
