# The development ICAP antivirus scanner — c-icap's virus_scan service in front of ClamAV, with the
# configuration in this directory. Test and development infrastructure, like MinIO beside it in
# ../docker-compose.yml; it is what the API's `AV_DRIVER=ICAP` adapter is validated against.
#
# Signatures are not baked in: `freshclam` fetches ClamAV's official databases when the container
# starts, into the `antivirus-signatures` volume, so a stale image never scans with stale signatures.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates clamav-daemon clamav-freshclam c-icap libc-icap-mod-virus-scan \
 && rm -rf /var/lib/apt/lists/*

COPY clamd.conf /etc/munaxa-antivirus/clamd.conf
COPY c-icap.conf /etc/munaxa-antivirus/c-icap.conf
COPY entrypoint.sh /usr/local/bin/munaxa-antivirus
COPY has-signatures.sh /usr/local/bin/has-signatures
# Inside the container the ICAP port faces the compose network rather than loopback.
RUN sed -i 's/^Port 127.0.0.1:1344$/Port 0.0.0.0:1344/' /etc/munaxa-antivirus/c-icap.conf \
 && chmod 755 /usr/local/bin/munaxa-antivirus /usr/local/bin/has-signatures \
 && mkdir -p /var/run/clamav /var/run/c-icap /var/log/c-icap \
 && chown clamav:clamav /var/run/clamav \
 && chown c-icap /var/run/c-icap /var/log/c-icap

EXPOSE 1344
ENTRYPOINT ["/usr/local/bin/munaxa-antivirus"]
