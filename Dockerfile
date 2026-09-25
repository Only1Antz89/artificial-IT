# One image, three roles.
#
# AIT, the simulated OpenClaw gateway and the simulated UI-TARS desktop bridge
# all live in this repository and share a build, so the compose stack pulls one
# image and picks a role per service. Keeping them in one image also keeps them
# honestly in step: the simulation cannot drift from the client it is standing
# in for if they are compiled together.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop the dev dependencies for the runtime layer.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Services bind all interfaces inside their container; the compose file decides
# what is published to the host.
ENV SIM_BIND_HOST=0.0.0.0

# Nothing useful to do by default: every service names its own command.
CMD ["node", "dist/src/cli.js", "serve"]
