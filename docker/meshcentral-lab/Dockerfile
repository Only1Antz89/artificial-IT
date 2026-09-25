FROM ghcr.io/ylianst/meshcentral:latest

COPY config.json /opt/meshcentral/lab-config.json
COPY entrypoint.sh /opt/meshcentral/lab-entrypoint.sh
RUN chmod 0755 /opt/meshcentral/lab-entrypoint.sh

ENTRYPOINT ["/opt/meshcentral/lab-entrypoint.sh"]
