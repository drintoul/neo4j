# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine

RUN mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp /usr/share/nginx/html && \
    chown -R nginx:nginx /tmp /usr/share/nginx/html

COPY --from=builder --chown=nginx:nginx /app/dist /usr/share/nginx/html
COPY --chown=nginx:nginx nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

USER nginx

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
