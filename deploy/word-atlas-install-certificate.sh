#!/usr/bin/env bash
set -euo pipefail
certificate_source=/etc/word-atlas-acme/live/43.133.166.184
certificate_target=/etc/word-atlas/tls
openssl x509 -in "$certificate_source/fullchain.pem" -noout -checkend 86400
openssl x509 -in "$certificate_source/fullchain.pem" -noout -checkip 43.133.166.184
install -d -m 0750 -o root -g word-atlas "$certificate_target"
install -m 0640 -o root -g word-atlas "$certificate_source/fullchain.pem" "$certificate_target/fullchain.pem.next"
install -m 0640 -o root -g word-atlas "$certificate_source/privkey.pem" "$certificate_target/privkey.pem.next"
mv "$certificate_target/fullchain.pem.next" "$certificate_target/fullchain.pem"
mv "$certificate_target/privkey.pem.next" "$certificate_target/privkey.pem"
if systemctl is-active --quiet word-atlas; then systemctl restart word-atlas; fi
