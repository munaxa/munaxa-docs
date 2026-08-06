# A self-signed certificate, for the SMTP suite and nothing else

`test-relay.cert.pem` and `test-relay.key.pem` are a throwaway RSA key pair generated for
`smtp-session.integration.spec.ts`, so the STARTTLS upgrade and the credential path can be
exercised against a **real** TLS handshake on a loopback socket rather than asserted around.

Two things make committing a private key here correct rather than the mistake it usually is.
It is generated for this repository and used by nothing: it authenticates `localhost` to a
server the suite starts and stops inside one test, and there is no system anywhere that would
accept it. And the alternative is worse — either the credential path goes untested, which is
exactly Phase 12's objection to building this adapter at all, or the suite generates a key
pair at run time, which needs an X.509 writer this product has no reason to own.

`17-security-architecture.md` §10 prohibits committing *a secret*. This is not one: a secret
is material that protects something, and nothing is protected by a certificate for `localhost`
that expires in a century and is in a public repository. It is test data shaped like a key.

Regenerate with:

```bash
openssl req -x509 -newkey rsa:2048 -days 36500 -nodes \
  -keyout test-relay.key.pem -out test-relay.cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
```
