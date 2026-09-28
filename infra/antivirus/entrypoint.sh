#!/bin/sh
# Signatures, then the engine, then the ICAP front end in the foreground.
set -eu
chown -R clamav:clamav /var/lib/clamav
if ! freshclam --stdout; then
  if ls /var/lib/clamav/*.cvd /var/lib/clamav/*.cld >/dev/null 2>&1; then
    echo "freshclam failed; scanning with the signatures already in the volume" >&2
  else
    echo "freshclam failed and there are no signatures: refusing to start a scanner that detects nothing" >&2
    exit 1
  fi
fi
clamd -c /etc/munaxa-antivirus/clamd.conf
exec c-icap -N -f /etc/munaxa-antivirus/c-icap.conf
