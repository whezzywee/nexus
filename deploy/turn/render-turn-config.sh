#!/bin/sh
set -eu

case "${NEXUS_TURN_REALM}" in
  *[!A-Za-z0-9.-]*|'') echo "NEXUS_TURN_REALM is invalid" >&2; exit 1 ;;
esac
case "${NEXUS_TURN_EXTERNAL_IP}" in
  *[!0-9A-Fa-f:./]*|'') echo "NEXUS_TURN_EXTERNAL_IP is invalid" >&2; exit 1 ;;
esac

umask 077
config=/run/coturn/turnserver.conf
: > "$config"
printf 'realm=%s\nserver-name=%s\nexternal-ip=%s\n' \
  "$NEXUS_TURN_REALM" \
  "$NEXUS_TURN_REALM" \
  "$NEXUS_TURN_EXTERNAL_IP" >> "$config"

secret_count=0
while IFS= read -r secret || [ -n "$secret" ]; do
  [ -z "$secret" ] && continue
  if [ "${#secret}" -lt 32 ]; then
    echo "Every TURN shared secret must contain at least 32 characters" >&2
    exit 1
  fi
  case "$secret" in
    *[!A-Za-z0-9_+=/.-]*)
      echo "TURN shared secrets must use base64-safe printable characters" >&2
      exit 1
      ;;
  esac
  printf 'static-auth-secret=%s\n' "$secret" >> "$config"
  secret_count=$((secret_count + 1))
done < /run/secrets/turn_secret

if [ "$secret_count" -eq 0 ]; then
  echo "At least one TURN shared secret is required" >&2
  exit 1
fi

cat /opt/nexus/turnserver.conf.base >> "$config"
exec turnserver -c "$config"
