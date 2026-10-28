FROM node:22-alpine
WORKDIR /app

COPY server.js deploy.js ./
COPY index.html ./
COPY p ./p

ENV PORT=3000
EXPOSE 3000
VOLUME /app/data

CMD ["node", "server.js"]
