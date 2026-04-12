FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
RUN npm install --omit=dev
COPY dist ./dist
EXPOSE 3000
CMD ["node", "server.js"]
