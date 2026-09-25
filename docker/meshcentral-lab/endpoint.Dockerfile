FROM ghcr.io/ylianst/meshcentral:latest AS meshcentral-source

FROM node:24-bookworm-slim

# The MeshCentral server image is Alpine/musl, while downloaded Linux agents
# target glibc. Keep the server on the official image and give the disposable
# endpoint a small Debian runtime where the real agent runs natively.
WORKDIR /opt/meshcentral
COPY --from=meshcentral-source /opt/meshcentral/meshcentral /opt/meshcentral/meshcentral

COPY endpoint.mjs /lab/endpoint.mjs

ENV MESHCTRL_PATH=/opt/meshcentral/meshcentral/meshctrl.js

ENTRYPOINT ["node", "/lab/endpoint.mjs"]
