#!/bin/sh
set -e

mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp

uri=$(printf '%s' "${NEO4J_URI:-bolt://localhost:7687}" | sed 's/"/\\"/g')
user=$(printf '%s' "${NEO4J_USER:-neo4j}" | sed 's/"/\\"/g')
password=$(printf '%s' "${NEO4J_PASSWORD:-password}" | sed 's/"/\\"/g')

printf 'window.ENV = {\n  NEO4J_URI: "%s",\n  NEO4J_USER: "%s",\n  NEO4J_PASSWORD: "%s"\n};\n' \
  "$uri" "$user" "$password" > /tmp/env.js

exec nginx -g "daemon off;"
