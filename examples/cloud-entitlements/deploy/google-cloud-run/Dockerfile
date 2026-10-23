FROM node:22-bookworm-slim
WORKDIR /app
COPY index.cjs ./index.cjs
USER node
EXPOSE 8080
CMD ["node", "index.cjs"]
