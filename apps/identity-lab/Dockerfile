FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV PORT=8787
# The standard launcher binds loopback. The container entry uses the factory
# directly to expose HTTP to its mapped port, while its data remains synthetic.
COPY scripts/docker-server.mjs ./scripts/
EXPOSE 8787
CMD ["node", "scripts/docker-server.mjs"]
