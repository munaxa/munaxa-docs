# TLS for the Hetzner deployment: options for decision D-2

- **Status:** a comparison for the owner's decision. **Nothing is selected, configured or
  deployed.** ADR-0026 §3 recommended option A; this note adds what that recommendation did not
  weigh (§2, residency), and says what must be shown before any option is chosen.
- **Date:** 2026-10-15.
- **What the template does today:**
  - Caddy terminates no TLS.
  - Its one published port is bound to `127.0.0.1:8080` until this decision is made
    (`infra/hetzner/compose.yaml`).
  - Behind Caddy the client-address chain is fixed and tested: `WEB_TRUST_PROXY` names the proxy,
    and `TRUST_PROXY` names the proxy and the web server by fixed address; `true` and `*` are
    refused.

## 1. Options

| | A. Cloudflare Tunnel | B. Cloudflare proxy + Origin CA | C. Caddy with ACME on the server | D. Hetzner Load Balancer with a managed certificate |
| --- | --- | --- | --- | --- |
| How | `cloudflared` on the server dials out to Cloudflare; Cloudflare terminates TLS and sends requests down the tunnel | Cloudflare terminates TLS; it connects to Caddy on 443 with a Cloudflare Origin CA certificate ("Full (strict)") | Caddy obtains a publicly trusted certificate (Let's Encrypt, HTTP-01 or TLS-ALPN-01) and terminates TLS itself | A Hetzner Load Balancer terminates TLS with a managed certificate and forwards to the server |
| Inbound ports on the server | **None** (SSH only) | 443 from Cloudflare's address ranges only | 80 and 443 from anywhere | From the load balancer only (private network) |
| **Where plaintext exists** | **Cloudflare's edge (any of its locations, unless restricted) and the server** | **Cloudflare's edge and the server** | **The server only** | The load balancer (Hetzner, same location) and the server |
| Certificate management | Cloudflare | Cloudflare at the edge; a 15-year Origin CA certificate on the server | Caddy renews automatically; port 80 or 443 must stay reachable for renewal | Hetzner |
| Client address | `CF-Connecting-IP`, trusted only from `cloudflared` | `CF-Connecting-IP`, trusted only from Cloudflare's ranges, and that list kept current | The TCP peer: nothing to trust | The PROXY protocol or `X-Forwarded-For` from the load balancer's address |
| DDoS and WAF | Cloudflare | Cloudflare | None beyond Hetzner's network-level protection | Hetzner's network-level protection |
| Extra component | `cloudflared` (a container) | None | None | A load balancer |
| Recurring cost (estimate) | €0 (free plan) | €0 (free plan) | €0 | A Hetzner load balancer's monthly price — **[estimate: a few euros a month; verify]** |
| Upload and download limits | **Cloudflare's request-size limit per plan applies to browser uploads that go through it.** Uploads here go **directly to the object store**, not through Cloudflare. Verified downloads stream through it. **[verify the current limits and timeouts]** | Same as A | None | Hetzner's limits **[verify]** |

## 2. What the earlier recommendation did not weigh

**With A or B, Cloudflare decrypts every request and response**: documents being downloaded,
previews, sign-in passwords and session cookies. On Cloudflare's standard plans, TLS can be
terminated at any of its edge locations, including outside the EU. Keeping termination in the EU
is a separate Cloudflare product, the Data Localization Suite, which is **not** on the free plan
**[verify the current product and plan]**.

So A and B:

- make Cloudflare a processor of document content, not only of DNS;
- conflict with a strict reading of "EU data residency" (gate G-1) unless that product is bought,
  or the owner accepts Cloudflare as a processor with transfers outside the EU under its DPA.

C keeps TLS end to end on the server in Germany or Finland. D keeps it within Hetzner, in the same
location.

This is a decision for the owner, with the customers' requirements in hand. It is not a technical
call. Nothing in the repository depends on the answer except the proxy and firewall configuration.

## 3. What each option needs before it is chosen (none done)

| Evidence | A | B | C | D |
| --- | --- | --- | --- | --- |
| The owner's residency position on TLS termination by a third party (§2) | required | required | — | — |
| Client-address chain wired and tested end to end: sign-in rate limit keyed on the real browser, audit records the real address (gap G-5) | required | required | required (simplest) | required |
| A proxy configuration change, reviewed and run through the stack test | Caddy `trusted_proxies` = the cloudflared container's fixed address; `client_ip_headers CF-Connecting-IP` | Caddy listener on 443 with the Origin CA certificate; `trusted_proxies` = Cloudflare ranges, plus a way to keep them current | Caddy site with automatic HTTPS; port 443 (and 80) published; HSTS | Caddy trusting the load balancer's private address |
| Firewall rules applied and tested from outside: only the intended ports answer | SSH only | 443 from Cloudflare ranges + SSH | 80/443 + SSH | load balancer → server only + SSH |
| A verified download of a large file and a preview through it, in a browser (timeouts, buffering) | required | required | required | required |
| Certificate expiry monitored (monitoring.md M15) | Cloudflare's | origin certificate (long-lived) | Caddy renewal | Hetzner's |

## 4. Recommendation

None is made until the owner has answered §2.

- If termination by a non-EU-restricted third party is **not** acceptable, **C** is the smallest
  change:
  - publish 443 (and 80 for the HTTP-01 challenge) on Caddy;
  - a Hetzner Cloud Firewall admitting 80, 443 and SSH from named addresses;
  - no `trusted_proxies`.
- If it **is** acceptable, **A** keeps the server's public IP closed and is what ADR-0026
  recommended.

Either way, D-2 stays open and ADR-0026 stays Proposed.
