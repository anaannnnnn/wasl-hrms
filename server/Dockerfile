FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev
COPY server ./server
COPY web ./web
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/healthz || exit 1
CMD ["node", "server/src/index.js"]
