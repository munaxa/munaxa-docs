#!/bin/sh
# Signatures, then the engine and its watch, then the ICAP front end in the foreground.
set -eu
# Runtime files left by an unclean stop (a killed container, a host or daemon restart) — STG-9.
# c-icap refuses to start while its PidFile exists ("c-icap server already running!") and exits 0,
# so under a restart policy the scanner looped for ever and never scanned again. Safe to clear: this
# script is PID 1 of the container's own process namespace, where no other clamd or c-icap can be
# running. The paths are the PidFile/CommandsSocket values in c-icap.conf and clamd.conf.
rm -f /var/run/c-icap/c-icap.pid /var/run/c-icap/c-icap.ctl /var/run/clamav/clamd.pid
# The container runs as `clamav` (Dockerfile), so it cannot take ownership of the signature volume;
# a fresh named volume inherits the image directory's clamav ownership, and one written by an earlier
# root-started image was chowned to clamav by it. Anything else is the operator's to fix — the update
# below then fails, and the scanner starts only if the volume already holds signatures.
if [ ! -w /var/lib/clamav ]; then
  echo "/var/lib/clamav is not writable by $(id -un) ($(id -u):$(id -g)); signatures cannot be updated" >&2
fi
if freshclam --stdout; then
  munaxa-scanner-watch record-refresh
elif /usr/local/bin/has-signatures /var/lib/clamav; then
  echo "freshclam failed; scanning with the signatures already in the volume" >&2
else
  echo "freshclam failed and there are no signatures: refusing to start a scanner that detects nothing" >&2
  exit 1
fi
# The engine, answering, BEFORE the ICAP server: c-icap started without a reachable engine answers
# 204 for everything (scanner-watch.sh, the fail-open guard). If the signatures are past
# SIGNATURE_REFUSE_AGE_HOURS this waits, with nothing listening, until a refresh succeeds. Then the
# watch that refreshes signatures, restarts a dead engine, reports staleness and guards against a
# fail-open answer (R-10).
munaxa-scanner-watch start
munaxa-scanner-watch run &
exec c-icap -N -f /etc/munaxa-antivirus/c-icap.conf
