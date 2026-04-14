FROM node:20-alpine

RUN addgroup -S travelagent && adduser -S travelagent -G travelagent

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev && npm cache clean --force

COPY . .

RUN chown -R travelagent:travelagent /app
USER travelagent

EXPOSE 8000

CMD ["node", "server.js"]
