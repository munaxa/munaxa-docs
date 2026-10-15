# PostgreSQL for the Hetzner template, with what its backups need — R-1 of the readiness report
# (docs/operations/backup-and-restore.md §5).
#
# The official image, unchanged, plus:
#   - age (https://age-encryption.org), the one encryption tool every backup file goes through.
#     Public-key: the server holds only the recipients, so a stolen backup disk or a stolen server
#     cannot decrypt a backup. The identity (private key) exists only offline and in a recovery
#     environment.
#   - three scripts: the WAL archive and restore commands, and `munaxa-backup` (base backups,
#     per-tenant dumps, retention, status, restore).
#   - a pg_hba.conf that admits the backup role for replication from the private data network.
#
# One image for both the `postgres` service (archive_command) and the `db-backup` service, so the
# client tools and the server are always the same version.
#
# BASE is the official image; it is an argument only so a build behind a TLS-intercepting proxy can
# substitute the same image with that proxy's CA added. Production builds use the default.
ARG BASE=postgres:16.10-alpine
FROM ${BASE}

# Pinned to the package Alpine 3.22 carries, so a rebuild cannot silently change the tool every
# backup depends on. A bump is a reviewed change, like any other dependency.
RUN apk add --no-cache age=1.2.1-r10

COPY --chmod=0755 archive-wal.sh /usr/local/bin/munaxa-archive-wal
COPY --chmod=0755 restore-wal.sh /usr/local/bin/munaxa-restore-wal
COPY --chmod=0755 backup.sh /usr/local/bin/munaxa-backup
COPY --chmod=0644 pg_hba.conf /etc/munaxa-postgres/pg_hba.conf
# COPY --chmod also applies its mode to the directory it creates; the server must be able to enter it.
RUN chmod 0755 /etc/munaxa-postgres
