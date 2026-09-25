#!/bin/bash
set -euo pipefail

config_file="${CONFIG_FILE:-/opt/meshcentral/meshcentral-data/config.json}"
admin_user="${MESHCENTRAL_ADMIN_USER:-aitadmin}"
admin_password="${MESHCENTRAL_ADMIN_PASSWORD:-change-me-meshcentral}"
marker="/opt/meshcentral/meshcentral-data/.ait-lab-admin"

mkdir -p "$(dirname "$config_file")"
# This is an intentionally disposable, deterministic lab server. Certificates,
# accounts and audit data persist in the volume, but its network policy always
# follows the version-controlled demo configuration.
cp /opt/meshcentral/lab-config.json "$config_file"

if [ ! -f "$marker" ]; then
  node /opt/meshcentral/meshcentral/meshcentral.js \
    --configfile "$config_file" \
    --createaccount "$admin_user" \
    --pass "$admin_password" \
    --email ait-lab@localhost
  node /opt/meshcentral/meshcentral/meshcentral.js \
    --configfile "$config_file" \
    --adminaccount "$admin_user"
  touch "$marker"
fi

exec /bin/bash /opt/meshcentral/entrypoint.sh
