#!/bin/sh
# Signatures, then the engine, then the ICAP front end in the foreground.
set -eu
# Runtime files left by an unclean stop (a killed container, a host or daemon restart) — STG-9.
# c-icap refuses to start while its PidFile exists ("c-icap server already running!") and exits 0,
# so under a restart policy the scanner looped for ever and never scanned again. Safe to clear: this
# script is PID 1 of the container's own process namespace, where no other clamd or c-icap can be
# running. The paths are the PidFile/CommandsSocket values in c-icap.conf and clamd.conf.
rm -f /var/run/c-icap/c-icap.pid /var/run/c-icap/c-icap.ctl /var/run/clamav/clamd.pid
chown -R clamav:clamav /var/lib/clamav
if ! freshclam --stdout; then
  if /usr/local/bin/has-signatures /var/lib/clamav; then
    echo "freshclam failed; scanning with the signatures already in the volume" >&2
  else
    echo "freshclam failed and there are no signatures: refusing to start a scanner that detects nothing" >&2
    exit 1
  fi
fi
clamd -c /etc/munaxa-antivirus/clamd.conf
exec c-icap -N -f /etc/munaxa-antivirus/c-icap.conf
