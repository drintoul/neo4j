# syntax=docker/dockerfile:1
FROM node:20-alpine

RUN mkdir -p /app && chown -R node:node /app

WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm install && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 3001
CMD ["npm", "start"]
