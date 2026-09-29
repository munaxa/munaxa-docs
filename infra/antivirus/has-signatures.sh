#!/bin/sh
# Exit 0 when the directory holds at least one non-empty ClamAV database (.cvd or .cld) — STG-8.
#
# Each file is tested on its own. The previous check, `ls DIR/*.cvd DIR/*.cld`, failed whenever
# either pattern matched nothing, so a volume holding only the .cvd files a first freshclam writes
# was taken for an empty one, and the scanner refused to start on valid signatures whenever the
# start-time update could not reach its mirror.
dir=${1:-/var/lib/clamav}
for database in "$dir"/*.cvd "$dir"/*.cld; do
  [ -s "$database" ] && exit 0
done
exit 1
