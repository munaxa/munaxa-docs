import { z } from 'zod';

/**
 * Typed configuration, validated once at boot.
 *
 * Two rules give this file its shape: a misconfigured process **fails to start** rather than
 * degrading silently at the first request, and a production deployment may never fall back
 * to a development driver (`docs/architecture/02-backend-architecture.md` §4).
 */
const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);

/**
 * Which shape of deployment this process is part of.
 *
 * It exists because two things genuinely differ between a customer's own server and the hosted
 * service, and neither is a code path in a use case. **How many tenants there are**: on premise there
 * is normally one, derived from the base environment, so an installation needs no catalogue at all.
 * And **which providers are acceptable in production**: a filesystem is the right storage for a single
 * server and the wrong storage for a fleet, so production validation differs.
 *
 * It is deliberately *not* consulted anywhere else. Business logic that branched on the deployment
 * profile would be business logic that behaves differently for a customer who bought the same product
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 */
const deploymentProfileSchema = z.enum(['ON_PREMISE', 'CLOUD']);

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .or(z.boolean());

export const configSchema = z
  .object({
    NODE_ENV: environmentSchema.default('development'),
    APP_NAME: z.string().default('munaxa-docs-api'),
    APP_VERSION: z.string().default('0.1.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    /** Allowed browser origins. Never `*`: the API is credentialed. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DEPLOYMENT_PROFILE: deploymentProfileSchema.default('ON_PREMISE'),

    /**
     * The single tenant's slug, for an installation that serves one company.
     *
     * Required when no catalogue is given, and refused when one is: a deployment either derives its
     * one tenant from this environment or reads a catalogue, and a configuration that did both would
     * have two answers to "which tenants exist".
     */
    TENANT_SLUG: z.string().trim().toLowerCase().optional(),
    /** The single tenant's identifier. Stable across restarts, because it is in every row. */
    TENANT_ID: z.string().uuid().optional(),

    /** The catalogue as JSON, for a container that receives it as an environment variable. */
    TENANT_CATALOGUE: z.string().min(1).optional(),
    /** The catalogue as a file, for a deployment that mounts it as a secret or a config map. */
    TENANT_CATALOGUE_PATH: z.string().min(1).optional(),

    DATABASE_URL: z.string().url(),
    /** The migration role. Separate from the application role, which has no BYPASSRLS. */
    DATABASE_MIGRATION_URL: z.string().url().optional(),
    /** Per **tenant**, not per process: the ceiling is this times the number of live clients. */
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
    /**
     * How many tenant databases one process holds connections to at once.
     *
     * A bound rather than a cache size: each client owns a pool, so the real limit is this times
     * `DATABASE_POOL_SIZE`, and PostgreSQL's `max_connections` is what it has to fit inside. The
     * least recently used client is disconnected when the bound is reached, which costs a reconnect
     * on the next request for that tenant and costs nothing at all for a single-tenant install.
     */
    DATABASE_MAX_TENANT_CLIENTS: z.coerce.number().int().min(1).max(1_000).default(25),

    REDIS_URL: z.string().url(),

    /**
     * Whether this process consumes background jobs as well as enqueuing them.
     *
     * Phase 4 is the first phase with anything to consume — the outbox dispatcher and the workflow
     * timers — and both run in the API process by default, because a single-server on-premise
     * installation is one process and a deployment where nothing consumes a lane is a deployment
     * where deadlines silently never fire.
     *
     * It is a switch rather than an assumption so that a horizontally scaled deployment can say so:
     * every instance enqueues, and one runs the consumers. Stated in configuration rather than
     * inferred from a hostname or an instance index, because "who is consuming this queue" must not
     * be something an operator has to work out.
     */
    QUEUE_CONSUMERS_ENABLED: booleanFromEnv.default(true),

    /** How many outbox rows the dispatcher claims per pass, and how often it looks. */
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),

    /** Signing material for access tokens. Rotated by adding a key, never by editing one. */
    JWT_ISSUER: z.string().default('https://docs.munaxa.com'),
    JWT_AUDIENCE: z.string().default('munaxa-docs'),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3_600).default(2_592_000),

    /**
     * Where an OIDC provider sends the browser back to — Phase 17.
     *
     * **Configured rather than taken from the request**, and that is the check whose absence is
     * the open-redirect in every hand-rolled OIDC integration: a `redirect_uri` read from a query
     * string is one an attacker sets to their own site, and the provider delivers the
     * authorization code there. It is also registered with the provider, which is the other half
     * of the same defence and the half this deployment does not control.
     *
     * Defaulted to the web client's own callback route, so a deployment that has already
     * configured `WEB_BASE_URL` needs nothing further.
     */
    FEDERATION_REDIRECT_URI: z.string().url().optional(),

    STORAGE_DRIVER: z.enum(['NONE', 'LOCAL', 'S3', 'AZURE_BLOB', 'R2', 'GCS']).default('NONE'),
    /** The bucket, container or root directory. A tenant's own prefix sits inside it. */
    STORAGE_BUCKET: z.string().optional(),
    STORAGE_REGION: z.string().optional(),
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
    STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(2_147_483_648),
    /**
     * The object store's credentials.
     *
     * Optional in the schema and required by the driver, which is not the same as optional: an S3
     * deployment on an instance role legitimately supplies neither, and one on a static key pair
     * supplies both. Supplying exactly one is the misconfiguration worth catching, and it is
     * caught below rather than at the first upload.
     */
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_SESSION_TOKEN: z.string().optional(),
    /**
     * Whether the bucket is addressed as a path segment rather than as a subdomain.
     *
     * MinIO and most S3-compatible stores need it; AWS deprecated it and Cloudflare R2 never had
     * it. It is a property of the endpoint rather than of the code, which is why it is a variable
     * and not a driver.
     */
    STORAGE_FORCE_PATH_STYLE: booleanFromEnv.default(false),
    /** Where the `LOCAL` driver keeps its files. Each tenant's prefix is a directory inside it. */
    STORAGE_LOCAL_ROOT: z.string().default('./.storage'),
    /**
     * The base URL browsers should use to reach the API's own transfer endpoints.
     *
     * The `LOCAL` driver has no presigning service in front of it, so the API issues its own
     * signed URLs against itself. They have to be absolute and reachable from a browser, which the
     * API cannot infer from the socket it is listening on when it sits behind a reverse proxy.
     */
    STORAGE_PUBLIC_URL: z.string().url().optional(),

    /**
     * The rolling integrity verifier — Phase 18, `17-security-architecture.md` §8.
     *
     * How many blobs one nightly pass reads back and re-hashes, and how large a blob it will
     * attempt. The second bound is not a preference: `StoragePort.read` answers with a whole
     * `Buffer`, so an unbounded pass would hold a 2 GB scan in a background lane's memory. A blob
     * above it is stamped as looked-at and left `UNVERIFIED`, which is honest and — critically —
     * stops it being returned by every subsequent pass for ever.
     *
     * The two together decide how long a full cycle takes. At the defaults, a tenant with 200,000
     * blobs is completely re-verified about every four months; a deployment that wants faster
     * raises the batch, and pays for it in reads against its object store.
     */
    STORAGE_INTEGRITY_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(200),
    STORAGE_INTEGRITY_MAX_BYTES: z.coerce.number().int().min(1_024).default(134_217_728),

    SEARCH_DRIVER: z.enum(['POSTGRES', 'OPENSEARCH']).default('POSTGRES'),
    /**
     * The coalescing window (`12-search-architecture.md` §6): changes to one document inside
     * it project once. Also the projection's added latency, so the default sits under the
     * two-second freshness target with room for the projection itself.
     */
    SEARCH_DEBOUNCE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    /** Documents per rebuild batch — one transaction and one resume point each. */
    SEARCH_REBUILD_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(200),
    /** How many recent searches each person keeps. */
    SEARCH_RECENT_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
    /**
     * The most body text one entry stores, in characters. A cap because the index row serves
     * highlighting and ranking, not archival: past this point more text sharpens nothing.
     */
    SEARCH_MAX_BODY_CHARS: z.coerce.number().int().min(10_000).max(5_000_000).default(1_000_000),

    /**
     * The resolved-decision cache of `08-permission-model.md` §8 (Phase 14).
     *
     * A TTL rather than a correctness mechanism: every write that could change an answer
     * invalidates by prefix in the same transaction, and the TTL is the backstop for the one thing
     * prefix invalidation cannot reach — a change made in another tenant's process to shared
     * ancestry. Short, because §8 says short and because the failure mode of a stale entry is
     * somebody seeing a document for another few seconds after being denied it.
     *
     * Zero disables the cache entirely, which is the switch to reach for when an authorisation
     * answer is under investigation: a cold cache produces the same answer by construction.
     */
    ACL_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
    /**
     * How many ACL entries one resolution will read for a caller before it stops narrowing.
     *
     * A bound rather than a page size. `visibilityFilter` reads every entry naming the caller in
     * the tenant, which is small by design — entries name roles and departments, not people, and
     * an administrator granting ten thousand of them to one subject has built something the
     * permissions screen cannot render either. Past the bound the filter degrades **closed**: it
     * keeps every deny it read and drops the tenant-wide allow, so the failure mode of an
     * unreasonable configuration is seeing less, never more.
     */
    ACL_MAX_SUBJECT_ENTRIES: z.coerce.number().int().min(100).max(100_000).default(5_000),
    /**
     * Time-based one-time passwords (Phase 14).
     *
     * `MFA_TOTP_STEP_SECONDS` and `MFA_TOTP_DIGITS` are RFC 6238's defaults and are configurable
     * because an authenticator app is the other half of the protocol and not every tenant's is the
     * same. `MFA_TOTP_SKEW_STEPS` is how many steps either side of now are accepted — one step is
     * the usual compromise between a slow phone clock and a captured code's useful life.
     */
    MFA_TOTP_STEP_SECONDS: z.coerce.number().int().min(15).max(120).default(30),
    MFA_TOTP_DIGITS: z.coerce.number().int().min(6).max(8).default(6),
    MFA_TOTP_SKEW_STEPS: z.coerce.number().int().min(0).max(4).default(1),
    /** How many single-use recovery codes an enrolment issues. Issued once, never re-shown. */
    MFA_RECOVERY_CODE_COUNT: z.coerce.number().int().min(4).max(24).default(10),
    /** Consecutive failed challenges before the enrolment refuses until an administrator resets it. */
    MFA_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(10),
    /**
     * The key a TOTP secret is sealed with at rest — Phase 18, and Phase 14's owed row.
     *
     * A TOTP secret is a symmetric key: unlike a password it cannot be hashed, because verifying a
     * code means computing one. Phase 14 sealed it under a key **derived from
     * `JWT_ACCESS_SECRET`**, which was careful — domain-separated, so one string was not doing two
     * cryptographic jobs — and left the two on one rotation clock. Rotating the token secret is
     * routine and costs at most one access token's lifetime; it also, silently, made every
     * enrolled authenticator unreadable.
     *
     * Its own key breaks that coupling, and the stored value names the key version that sealed it
     * so a rotation is survivable: both keys unseal, new seals use this one, and a stale row is
     * re-sealed the next time its owner proves a code
     * ([ADR-0020](../../../../../docs/architecture/adr/0020-key-management-and-rotation.md)).
     *
     * Optional in the schema and **required in production**, exactly like the checkpoint and
     * witness secrets: a development machine keeps Phase 14's derivation and behaves byte for byte
     * as it did, and a production deployment states the key it is willing to be held to.
     */
    MFA_TOTP_SEALING_KEY: z.string().min(32).optional(),
    OCR_DRIVER: z.enum(['NONE', 'TESSERACT', 'HOSTED']).default('NONE'),
    /** Where the `TESSERACT` driver finds its binary. A path, so an installer can pin one. */
    OCR_TESSERACT_PATH: z.string().default('tesseract'),
    /** The languages the engine is asked to read, in its own syntax. */
    OCR_LANGUAGES: z.string().default('ara+eng'),
    MAIL_DRIVER: z.enum(['NONE', 'SMTP', 'RESEND']).default('NONE'),
    /**
     * The hosted provider's API key and endpoint.
     *
     * The endpoint is configurable so a deployment can point at a compatible gateway, an egress
     * proxy or a test double, rather than at a hostname compiled into the adapter.
     */
    MAIL_RESEND_API_KEY: z.string().min(1).optional(),
    /**
     * The relay an on-premise installation sends through — Phase 18, and Phase 12's owed row.
     *
     * `SMTP` has been in this enum since Phase 0.5 and refused at boot since Phase 12, whose
     * reason was testability rather than preference: *"an untested hand-rolled SMTP client is a
     * larger risk than an unbuilt one"*. Phase 18 answers the "untested" half — the message
     * building is pure and unit-tested against the specifications' own examples, and the session
     * is driven against transcripts of real servers over a loopback socket — and builds it,
     * because on-premise deployment is this phase's subject and 18 §3 has asked for this row
     * since Phase 0.
     */
    MAIL_SMTP_HOST: z.string().min(1).optional(),
    MAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    /**
     * How the channel is secured.
     *
     * `STARTTLS` on 587 is the modern default and is what this defaults to; `TLS` is implicit TLS
     * on 465; `NONE` is a relay on the same host or the same private network and is the only value
     * that refuses credentials, because both authentication mechanisms base64 a password and
     * base64 is an encoding rather than a protection.
     */
    MAIL_SMTP_SECURITY: z.enum(['NONE', 'STARTTLS', 'TLS']).default('STARTTLS'),
    MAIL_SMTP_USERNAME: z.string().min(1).optional(),
    MAIL_SMTP_PASSWORD: z.string().min(1).optional(),
    /**
     * Whether the relay's certificate must validate.
     *
     * A variable rather than a default, because an on-premise relay with an internal certificate
     * authority nobody installed is a real configuration — and because turning validation off must
     * be an act an operator performs and an auditor can find, rather than something the adapter
     * decided.
     */
    MAIL_SMTP_REJECT_UNAUTHORIZED: booleanFromEnv.default(true),
    /**
     * The name this client announces in `EHLO`.
     *
     * Its own variable because some relays refuse a name that does not resolve, and a container's
     * hostname is a random hex string. Defaulted to the deployment's own web host, which is the
     * one name an operator has already had to get right.
     */
    MAIL_SMTP_CLIENT_NAME: z.string().min(1).optional(),
    MAIL_RESEND_ENDPOINT: z.string().url().default('https://api.resend.com/emails'),
    /** How long one send may take before it is abandoned and retried as a transient failure. */
    MAIL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    /**
     * Who the mail comes from.
     *
     * Deployment configuration rather than a tenant setting: the address has to be one the
     * sending domain is authorised for — SPF, DKIM and DMARC are properties of the deployment —
     * and letting a tenant choose it would be letting a tenant fail everybody else's deliverability.
     */
    MAIL_FROM_ADDRESS: z.string().email().optional(),
    MAIL_FROM_NAME: z.string().min(1).default('Munaxa Docs'),
    /**
     * Where a notification's deep links point.
     *
     * 18 §4: "a notification carries a deep link and enough context to act". The link resolves
     * through ordinary authorisation like any other route — §8's third prohibition is that a
     * notification never grants access *by virtue of* a link, and this one grants nothing.
     */
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    AV_DRIVER: z.enum(['NONE', 'ICAP', 'HOSTED']).default('NONE'),
    /**
     * The office-to-PDF converter. `NONE` degrades honestly: Office documents keep their
     * extracted text and lose their paginated rendition — the same posture as `OCR_DRIVER=NONE`.
     * Deliberately absent from the production must-be-real list beside it: a deployment that
     * previews Office documents as text is degraded, not misconfigured.
     */
    OFFICE_DRIVER: z.enum(['NONE', 'LIBREOFFICE']).default('NONE'),
    OFFICE_LIBREOFFICE_PATH: z.string().default('soffice'),

    /**
     * The render sandbox's resource caps (`14-preview-architecture.md` §5). Deployment-tunable
     * because they are capacity statements, not correctness ones — every value here trades
     * "how large a document previews" against "how much one job may cost".
     */
    PREVIEW_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    /** Sources above this are not rendered at all — the honest answer for a 2 GB scan. */
    PREVIEW_MAX_SOURCE_BYTES: z.coerce.number().int().min(1_048_576).default(134_217_728),
    PREVIEW_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(67_108_864),
    PREVIEW_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(500),
    PREVIEW_MAX_TEXT_BYTES: z.coerce.number().int().min(4_096).default(2_097_152),
    PREVIEW_MAX_ARCHIVE_ENTRIES: z.coerce.number().int().min(16).default(4_096),
    PREVIEW_MAX_ARCHIVE_EXPANSION_RATIO: z.coerce.number().int().min(2).default(200),
    PREVIEW_MAX_PIXELS: z.coerce.number().int().min(65_536).default(40_000_000),

    /**
     * Audit reading, verification and evidence export (`13-audit-architecture.md` §§4–6).
     *
     * The buffer's three bounds are one policy read three ways: flush when either the soft
     * count or the interval is reached, and *never* exceed the hard bound — past it `record`
     * writes synchronously rather than dropping, because §7's "silently drop on failure" is
     * the one thing an audit trail may not do. The hard bound is therefore how much evidence a
     * process may hold un-durable, and the honest way to read it is "how much would a crash
     * lose": at the default, a thousand views.
     */
    AUDIT_READ_BUFFER_SIZE: z.coerce.number().int().min(1).max(100_000).default(200),
    AUDIT_READ_BUFFER_MAX: z.coerce.number().int().min(1).max(1_000_000).default(1_000),
    AUDIT_READ_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).max(300_000).default(2_000),

    /**
     * The key the daily checkpoint is signed with.
     *
     * §4 requires checkpoints to live "in a separate store so an attacker with database access
     * alone cannot rewrite history undetected". The store is object storage; the *signature* is
     * what makes the separation mean something, because an attacker who reaches the bucket as
     * well still cannot forge a checkpoint without this. It is therefore held where neither the
     * database nor the bucket is — in the deployment's own secret material.
     *
     * Optional in the schema and required in production, like every other real provider: a
     * development environment without one verifies the chain and records no checkpoint, and
     * says so rather than writing an unsigned one.
     */
    AUDIT_CHECKPOINT_SECRET: z.string().min(32).optional(),

    /**
     * The key the server witnesses an electronic signature with — Phase 16, ADR-0017.
     *
     * **Its own secret rather than the checkpoint's**, and the separation is the point. The two
     * attest different things on different clocks: a checkpoint attests a day of the audit trail
     * and can be rotated whenever an operator likes, because every old checkpoint has already been
     * verified. A signature attests a person's act and must go on verifying for as long as the
     * record is retained — seven years, frequently more — so its rotation is an event with a
     * migration behind it. Sharing one key would tie the cheap rotation to the expensive one.
     *
     * The key *identifier* is derived from the key itself rather than configured beside it, so an
     * operator who rotates the secret cannot forget to change the name — and every signature made
     * under the old key keeps naming it, which is what makes a rotation survivable instead of a
     * mass invalidation.
     *
     * Optional in the schema and required in production, exactly like the checkpoint secret. A
     * deployment without one refuses to sign rather than writing an unwitnessed signature, because
     * a signature nothing witnessed is a row that looks identical to one that was.
     */
    SIGNATURE_WITNESS_SECRET: z.string().min(32).optional(),

    /** Events read per pass while verifying, and the ceiling on one pass's work. */
    AUDIT_VERIFY_BATCH_SIZE: z.coerce.number().int().min(100).max(100_000).default(5_000),
    /**
     * The most one verification pass walks.
     *
     * A first pass over a seven-year trail would otherwise hold the lane for hours. Each pass
     * checkpoints where it stopped and the next resumes there, so a deployment catches up over
     * a few nights and then settles into verifying one day at a time.
     */
    AUDIT_VERIFY_MAX_EVENTS: z.coerce.number().int().min(1_000).default(200_000),

    /** Events read per batch while an evidence bundle streams to storage. */
    AUDIT_EXPORT_BATCH_SIZE: z.coerce.number().int().min(100).max(50_000).default(2_000),

    /**
     * Which rendering rule an evidence bundle's `events.csv` is written under — Phase 18.
     *
     * Phase 15 found that Phase 9's evidence CSV neutralises no spreadsheet formula and that its
     * own comment claimed otherwise, and deliberately did not fix it: an evidence bundle's bytes
     * are what a signed manifest's digest attests, so rewriting the writer silently changes what a
     * re-export of the same range produces.
     *
     * The default is the fix. `RFC4180` is Phase 9's exact behaviour, kept reachable so an
     * investigation holding a bundle produced before this change can reproduce its bytes and check
     * them against the digest in the manifest it already has. Whichever is used is **recorded on
     * the manifest**, which is what makes the difference legible rather than a surprise.
     */
    AUDIT_EXPORT_CSV_PROFILE: z
      .enum(['RFC4180', 'RFC4180_FORMULA_NEUTRALISED'])
      .default('RFC4180_FORMULA_NEUTRALISED'),

    /**
     * Rows read per page while a report export streams to storage — Phase 15.
     *
     * Its own knob rather than sharing `AUDIT_EXPORT_BATCH_SIZE`, because the two read different
     * things: an evidence batch is a slice of one table by sequence, and a report page is a joined,
     * ACL-filtered query whose cost per row is an order of magnitude higher. Tuning one to the
     * other's shape would make whichever was tuned second worse.
     */
    REPORTING_EXPORT_BATCH_SIZE: z.coerce.number().int().min(50).max(10_000).default(500),

    /**
     * The most rows a report export writes before it stops and says it stopped.
     *
     * A bound rather than a preference: an unbounded export is an unbounded job on a lane with a
     * fifteen-minute budget, and the failure mode is a file that never appears rather than one that
     * is honest about its size. Reaching it sets `truncated` on the record, on the wire and in the
     * audit row — a silently capped report is one somebody reconciles against.
     */
    REPORTING_EXPORT_MAX_ROWS: z.coerce.number().int().min(1_000).max(5_000_000).default(250_000),

    /**
     * And the smaller bound a PDF gets, because a PDF is assembled rather than streamed.
     *
     * Its cross-reference table states the byte offset of every object, so the document exists in
     * memory before it can be written. That is the format, not the library, and it is why this
     * number is two orders of magnitude below the one above.
     */
    REPORTING_PDF_MAX_ROWS: z.coerce.number().int().min(100).max(200_000).default(5_000),

    /**
     * How much of a streamed object is held in memory before it is sent.
     *
     * The multipart minimum at every S3-compatible store is 5 MiB, which is the floor rather
     * than the default; above it, this is the only memory an export of any size costs.
     */
    STORAGE_STREAM_PART_BYTES: z.coerce.number().int().min(5_242_880).default(8_388_608),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(300),

    /**
     * The hosts this deployment will make an outbound request to — 17 §6's "configured
     * allow-list", Phase 17.
     *
     * Comma-separated. An entry with a leading dot covers its subdomains
     * (`.hooks.example.com`); one without covers exactly itself. **Empty is the default, and
     * empty means nothing is reachable** — so webhooks, federation and audit push are all
     * inert on a deployment where an operator has not named a host, which is the correct
     * posture for a control whose failure mode is the server attacking its own network.
     *
     * An *operator's* setting rather than a tenant's, uniquely among this phase's configuration.
     * Everything else an integration needs is tenant data a tenant administrator edits; this is
     * the boundary those administrators sit inside, and a boundary the people inside it can move
     * is not one.
     */
    OUTBOUND_HTTP_ALLOWLIST: z.string().default(''),
    /**
     * Whether `http://` is fetched as well as `https://`.
     *
     * For a development collector on a laptop and nothing else — which is why it is refused in
     * production below rather than merely discouraged. A webhook over plaintext puts a signed
     * payload and its signature on the wire for anybody on the path.
     */
    OUTBOUND_HTTP_ALLOW_INSECURE: booleanFromEnv.default(false),
    OUTBOUND_HTTP_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).default(65_536),

    OPENAPI_ENABLED: booleanFromEnv.default(true),
    /**
     * Whether the machine-readable schema is served, separately from the human explorer.
     *
     * **They were one flag until Phase 17, and treating them as one thing was the mistake.** 15 §6
     * says OpenAPI is "served at `/api/docs` in non-production **and emitted as a build
     * artifact**" — two deliverables with two audiences. The explorer is an interactive surface
     * that enumerates every route in the product and is correctly refused in production. The
     * *document* is a contract: it is what an SDK is generated from, what a customer's integration
     * team reads, and what a compatibility check diffs between releases — and refusing to serve it
     * in production means the one deployment whose contract anybody cares about is the one that
     * will not state it.
     *
     * Defaulted on and permitted in production. It is served on a route that renders no HTML,
     * executes nothing, and describes routes the caller is refused by every guard in the product
     * anyway — enumerating an API is not a permission this product has ever pretended to enforce,
     * because `RoutePermissionRegistry` publishes the whole route table at boot and 15 §8 requires
     * deprecations to be announced in it.
     */
    OPENAPI_DOCUMENT_ENABLED: booleanFromEnv.default(true),
    /**
     * Where this deployment's telemetry goes — Phase 18, and Phase 0.5's debt row 9.
     *
     * The port and its label rule have existed since Phase 0.5 with nothing bound to them,
     * deliberately: *"which backend a deployment scrapes is an operational decision, and binding
     * one now would make it an architectural one"*. That reasoning is why this is a driver rather
     * than a client library, and why `PROMETHEUS` exposes a **pull** endpoint instead of pushing:
     * the text format is read directly by Prometheus, VictoriaMetrics, Grafana Agent, the
     * OpenTelemetry Collector and every hosted agent worth naming, so it declines to choose for a
     * customer in the way an OTLP push would.
     *
     * `NONE` is a no-op rather than a refusal — the one driver in this file that is — and the
     * adapter says why: a deployment with no storage cannot store a document, and a deployment
     * with no metrics works and is simply unobserved. Telemetry that failed the work it watches
     * would be the observability layer becoming the outage.
     */
    METRICS_DRIVER: z.enum(['NONE', 'PROMETHEUS']).default('NONE'),
    /**
     * The bearer token `/api/metrics` requires.
     *
     * A metrics body is queue depths, error rates, refusal counts by permission and the route
     * table with volumes — no tenant's data and a great deal of reconnaissance. Required whenever
     * the driver is real, in **every** environment, because a scrape endpoint that is
     * unauthenticated on a developer's machine is one that ships unauthenticated the first time
     * somebody copies the compose file.
     */
    METRICS_SCRAPE_TOKEN: z.string().min(32).optional(),
    /**
     * The registry's series bound.
     *
     * `METRIC_CATALOGUE` already refuses any label it does not declare, so this is the backstop
     * for the case a declaration cannot see — a label whose set is bounded in principle and large
     * in practice, such as a route table that grows. Past it, new series are refused, existing
     * ones keep updating, and `edms_metrics_series_dropped_total` says it happened.
     */
    METRICS_MAX_SERIES: z.coerce.number().int().min(100).max(1_000_000).default(5_000),
    /**
     * How often lane depth and the outbox backlog are sampled.
     *
     * Its own interval because those two are the only *levels* in the catalogue — everything else
     * is recorded where it happens and costs nothing — and sampling them is a Redis round trip per
     * lane plus a bounded query per tenant database. The sampler does not start at all under
     * `METRICS_DRIVER=NONE`, so this number is only ever paid by a deployment that scrapes.
     */
    METRICS_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
    /**
     * Named by 20 §3 since Phase 0, read by nothing, and now refused rather than ignored.
     *
     * Both of these describe *exporters this build does not contain*. Sentry needs its SDK and
     * OTLP needs an encoder, and neither can reach the lockfile in the environment these phases
     * are authored in (see the Phase 18 report). A variable that is accepted and ignored is worse
     * than one that is refused: an operator who sets it believes errors are reaching Sentry, and
     * discovers otherwise during the incident it was set for. The `OCR_DRIVER=HOSTED` and
     * `SEARCH_DRIVER=OPENSEARCH` precedent, applied to configuration rather than to a driver.
     */
    SENTRY_DSN: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((config, ctx) => {
    // --- Tenancy, in every environment ---------------------------------------------------
    //
    // A deployment either derives its one tenant from this environment or reads a catalogue.
    // Checked everywhere rather than only in production, because a development environment that
    // silently ignored half its tenancy configuration is a development environment that proves
    // nothing about the deployment it is standing in for.
    const catalogueSources = [
      ['TENANT_CATALOGUE', config.TENANT_CATALOGUE],
      ['TENANT_CATALOGUE_PATH', config.TENANT_CATALOGUE_PATH],
    ].filter(([, value]) => value !== undefined);

    if (catalogueSources.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANT_CATALOGUE'],
        message: 'Give the catalogue inline or as a file, not both.',
      });
    }

    const hasCatalogue = catalogueSources.length > 0;
    if (hasCatalogue) {
      for (const key of ['TENANT_SLUG', 'TENANT_ID'] as const) {
        if (config[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} describes a single-tenant install and cannot be combined with a catalogue.`,
          });
        }
      }
    } else {
      for (const key of ['TENANT_SLUG', 'TENANT_ID'] as const) {
        if (config[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `Set ${key} for a single-tenant install, or give a tenant catalogue.`,
          });
        }
      }
      if (config.DEPLOYMENT_PROFILE === 'CLOUD') {
        // The hosted service serves more than one company by definition. A cloud process with one
        // tenant derived from its own environment is a misconfiguration that would look like a
        // working installation until the second customer signed up.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TENANT_CATALOGUE'],
          message: 'The cloud profile requires a tenant catalogue.',
        });
      }
    }

    // --- Storage, in every environment ---------------------------------------------------
    //
    // These were production-only until Phase 3, and they were wrong to be. They describe what a
    // *driver* needs in order to work at all, not what production demands of a deployment — an S3
    // driver with no bucket cannot address an object in staging either, and the failure it
    // produces there is a 500 on the first upload rather than a refusal to start. A development
    // environment that silently ignores half its storage configuration is a development
    // environment that proves nothing about the deployment it stands in for, which is the same
    // reasoning that put tenancy validation outside this block.
    if (config.STORAGE_DRIVER !== 'NONE' && config.STORAGE_DRIVER !== 'LOCAL') {
      if (!config.STORAGE_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_BUCKET'],
          message: 'A remote storage driver requires STORAGE_BUCKET.',
        });
      }
      // One half of a key pair is never a working configuration, and it is the shape a partly
      // filled `.env` takes. Neither is legitimate — an instance role supplies its own — so it is
      // the mismatch that is refused, not the absence.
      const keyId = config.STORAGE_ACCESS_KEY_ID !== undefined;
      const secret = config.STORAGE_SECRET_ACCESS_KEY !== undefined;
      if (keyId !== secret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [keyId ? 'STORAGE_SECRET_ACCESS_KEY' : 'STORAGE_ACCESS_KEY_ID'],
          message: 'Give both halves of the storage key pair, or neither.',
        });
      }
    }
    if (config.DEPLOYMENT_PROFILE === 'CLOUD' && config.STORAGE_DRIVER === 'LOCAL') {
      // A filesystem is the right storage for one server and the wrong storage for a fleet: it is
      // not shared between instances, so a document uploaded through one is missing from the next.
      // Checked outside the production block for the same reason as the rest: a cloud staging
      // environment on a local filesystem is a staging environment that cannot reproduce its own
      // production defects.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message: 'The cloud profile requires object storage, not a local filesystem.',
      });
    }

    // --- SMTP, in every environment ------------------------------------------------------
    //
    // Outside the production block for the same reason storage is: these describe what the
    // *driver* needs in order to work at all. A relay with no host cannot deliver in staging
    // either, and the failure it produces there is an approval nobody was told about.
    if (config.MAIL_DRIVER === 'SMTP') {
      if (config.MAIL_SMTP_HOST === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_SMTP_HOST'],
          message: 'MAIL_DRIVER=SMTP requires a relay host.',
        });
      }
      // One half of a credential pair is never a working configuration, and it is the shape a
      // partly filled `.env` takes — the same check the storage key pair gets.
      const username = config.MAIL_SMTP_USERNAME !== undefined;
      const password = config.MAIL_SMTP_PASSWORD !== undefined;
      if (username !== password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [username ? 'MAIL_SMTP_PASSWORD' : 'MAIL_SMTP_USERNAME'],
          message: 'Give both halves of the SMTP credential, or neither.',
        });
      }
      if (username && config.MAIL_SMTP_SECURITY === 'NONE') {
        // Refused here as well as in the session, because a deployment should learn at boot that
        // its two settings disagree rather than at the first send.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_SMTP_SECURITY'],
          message:
            'SMTP credentials require STARTTLS or TLS; base64 is an encoding, not a defence.',
        });
      }
    }

    // --- Observability, in every environment ---------------------------------------------
    //
    // Outside the production block for the reason storage and tenancy are: a development
    // environment that silently ignores half its observability configuration proves nothing about
    // the deployment it stands in for, and an unauthenticated scrape endpoint on a laptop is one
    // that ships the first time somebody copies the compose file.
    if (config.METRICS_DRIVER !== 'NONE' && config.METRICS_SCRAPE_TOKEN === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['METRICS_SCRAPE_TOKEN'],
        message: 'A metrics exporter needs a scrape token; the body is operator-only.',
      });
    }
    for (const [key, value] of [
      ['SENTRY_DSN', config.SENTRY_DSN],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', config.OTEL_EXPORTER_OTLP_ENDPOINT],
    ] as const) {
      if (value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} has no exporter in this build; unset it. Errors are on the structured log stream and metrics are served at /api/metrics under METRICS_DRIVER=PROMETHEUS.`,
        });
      }
    }

    if (config.NODE_ENV !== 'production') {
      return;
    }
    // Production may not run on a placeholder. An unconfigured driver in production is a
    // silent outage waiting for its first upload, so it is a boot failure instead.
    const productionDrivers = [
      ['STORAGE_DRIVER', config.STORAGE_DRIVER],
      ['MAIL_DRIVER', config.MAIL_DRIVER],
      ['AV_DRIVER', config.AV_DRIVER],
    ] as const;
    for (const [key, value] of productionDrivers) {
      if (value === 'NONE') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must name a real provider in production.`,
        });
      }
    }
    if (config.MAIL_DRIVER === 'RESEND' && config.MAIL_RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_RESEND_API_KEY'],
        message: 'MAIL_DRIVER=RESEND requires an API key.',
      });
    }
    if (config.MAIL_DRIVER !== 'NONE' && config.MAIL_FROM_ADDRESS === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_FROM_ADDRESS'],
        message: 'A mail driver needs an address to send from.',
      });
    }
    if (config.OPENAPI_ENABLED) {
      // The *explorer*, and only the explorer. `OPENAPI_DOCUMENT_ENABLED` is deliberately not
      // refused here — Phase 17 split the two, and the reasoning is on that variable.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAPI_ENABLED'],
        message: 'The OpenAPI explorer is not served in production.',
      });
    }
    if (config.MAIL_DRIVER === 'SMTP' && config.MAIL_SMTP_SECURITY === 'NONE') {
      // Permitted outside production for a relay on the same host, which is a legitimate
      // single-server arrangement. In production the message travels a network somebody else
      // operates, and a notification names a document and a person.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_SMTP_SECURITY'],
        message: 'Production mail is sent over STARTTLS or TLS.',
      });
    }
    if (config.MAIL_DRIVER === 'SMTP' && !config.MAIL_SMTP_REJECT_UNAUTHORIZED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_SMTP_REJECT_UNAUTHORIZED'],
        message: 'A production relay presents a certificate this deployment can validate.',
      });
    }
    if (config.OUTBOUND_HTTP_ALLOW_INSECURE) {
      // A signed webhook payload over plaintext is the payload and its signature on the wire.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OUTBOUND_HTTP_ALLOW_INSECURE'],
        message: 'Outbound requests are https-only in production.',
      });
    }
    if (config.SIGNATURE_WITNESS_SECRET === undefined) {
      // A production deployment with signatures turned on and no witness key would refuse every
      // signing attempt at the use case — correct, and discovered by whoever tries to sign rather
      // than by whoever deploys. This is the same trade the checkpoint secret makes below.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SIGNATURE_WITNESS_SECRET'],
        message: 'Electronic signatures must be witnessed in production.',
      });
    }
    if (config.MFA_TOTP_SEALING_KEY === undefined) {
      // Without it the product still seals, under Phase 14's key derived from the token secret —
      // which works, and puts a routine rotation of the signing secret one step away from making
      // every enrolled authenticator in the deployment unreadable. A production deployment states
      // its own key so that the two clocks are separate, which is what ADR-0020 asks for.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_TOTP_SEALING_KEY'],
        message: 'Authenticator secrets need their own sealing key in production.',
      });
    }
    if (config.AUDIT_CHECKPOINT_SECRET === undefined) {
      // Without it the daily pass still verifies and still alerts, but it records nothing an
      // auditor can hold against a later reading of the table — which is the whole of §4's
      // "an attacker with database access alone cannot rewrite history undetected". A
      // production deployment that boots without one would look identical to one that had it,
      // and would only be found to differ during the incident it exists for.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIT_CHECKPOINT_SECRET'],
        message: 'Audit checkpoints must be signed in production.',
      });
    }
  });

export type RawConfig = z.infer<typeof configSchema>;

/** The shape the application reads. Grouped, so a module injects what it needs and no more. */
export interface AppConfig {
  readonly env: z.infer<typeof environmentSchema>;
  readonly isProduction: boolean;
  /** Read by the tenant registry and by production validation. Nowhere else. */
  readonly deployment: {
    readonly profile: z.infer<typeof deploymentProfileSchema>;
    /**
     * Where the catalogue comes from. `SINGLE` derives one tenant from this environment, which is
     * what an on-premise installation needs and what every test uses.
     */
    readonly tenants:
      | { readonly source: 'SINGLE'; readonly id: string; readonly slug: string }
      | { readonly source: 'INLINE'; readonly document: string }
      | { readonly source: 'FILE'; readonly path: string };
  };
  readonly app: { readonly name: string; readonly version: string; readonly port: number };
  readonly http: {
    readonly corsOrigins: readonly string[];
    /** The interactive explorer. Refused in production. */
    readonly openApiEnabled: boolean;
    /** The machine-readable schema. Permitted in production — Phase 17 split the two. */
    readonly openApiDocumentEnabled: boolean;
  };
  readonly log: { readonly level: RawConfig['LOG_LEVEL'] };
  readonly database: {
    readonly url: string;
    readonly migrationUrl: string | null;
    readonly poolSize: number;
    readonly statementTimeoutMs: number;
    readonly maxTenantClients: number;
  };
  readonly redis: { readonly url: string };
  /**
   * Background work.
   *
   * Phase 4 is the first phase with any: the outbox has been accumulating events transactionally
   * since Phase 1 with nothing consuming them, and the workflow engine's deadlines are delayed jobs.
   */
  readonly queue: {
    readonly consumersEnabled: boolean;
    readonly outboxBatchSize: number;
    readonly outboxPollIntervalMs: number;
  };
  readonly auth: {
    readonly issuer: string;
    readonly audience: string;
    readonly accessSecret: string;
    readonly accessTtlSeconds: number;
    readonly refreshTtlSeconds: number;
    /** Where an OIDC provider returns the browser. Configured, never taken from a request. */
    readonly federationRedirectUri: string;
  };
  readonly storage: {
    readonly driver: RawConfig['STORAGE_DRIVER'];
    readonly bucket: string | null;
    readonly region: string | null;
    readonly endpoint: string | null;
    readonly signedUrlTtlSeconds: number;
    readonly maxUploadBytes: number;
    /** Null when the deployment supplies credentials some other way — an instance role. */
    readonly credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken: string | null;
    } | null;
    readonly forcePathStyle: boolean;
    readonly localRoot: string;
    readonly publicUrl: string | null;
    /** The chunk a streamed write sends at a time — the only memory a large artefact costs. */
    readonly streamPartBytes: number;
    /** The rolling integrity verifier's page, and the largest blob it will read back — Phase 18. */
    readonly integrityBatchSize: number;
    readonly integrityMaxBytes: number;
  };
  readonly providers: {
    readonly search: RawConfig['SEARCH_DRIVER'];
    readonly ocr: RawConfig['OCR_DRIVER'];
    readonly mail: RawConfig['MAIL_DRIVER'];
    readonly antivirus: RawConfig['AV_DRIVER'];
    readonly office: RawConfig['OFFICE_DRIVER'];
  };
  readonly ocr: {
    readonly tesseractPath: string;
    readonly languages: string;
  };
  /** Outbound mail, and where a notification's deep links point (`18-notification-architecture.md`). */
  readonly mail: {
    readonly resendApiKey: string | null;
    /** The relay, for `MAIL_DRIVER=SMTP` — Phase 18. Null host means the driver is not SMTP. */
    readonly smtp: {
      readonly host: string | null;
      readonly port: number;
      readonly security: RawConfig['MAIL_SMTP_SECURITY'];
      readonly username: string | null;
      readonly password: string | null;
      readonly clientName: string;
      readonly rejectUnauthorized: boolean;
    };
    readonly resendEndpoint: string;
    readonly timeoutMs: number;
    readonly fromAddress: string | null;
    readonly fromName: string;
    readonly webBaseUrl: string;
  };
  readonly search: {
    readonly debounceMs: number;
    readonly rebuildBatchSize: number;
    readonly recentLimit: number;
    readonly maxBodyChars: number;
  };
  /** The resolved-decision cache and the walk's bounds (`08-permission-model.md` §8). */
  readonly acl: {
    readonly cacheTtlSeconds: number;
    readonly maxSubjectEntries: number;
  };
  /** The second factor (`17-security-architecture.md` §2). */
  readonly mfa: {
    readonly totpStepSeconds: number;
    readonly totpDigits: number;
    readonly totpSkewSteps: number;
    readonly recoveryCodeCount: number;
    readonly maxFailedAttempts: number;
    /** Null in a deployment that keeps Phase 14's derived key; required in production. */
    readonly sealingKey: string | null;
  };
  readonly office: {
    readonly libreofficePath: string;
  };
  /** Reading, verifying and exporting the trail (`13-audit-architecture.md` §§4–6). */
  readonly audit: {
    readonly readBufferSize: number;
    readonly readBufferMax: number;
    readonly readFlushIntervalMs: number;
    /** Null in a deployment that has not been given one; no key, no checkpoint. */
    readonly checkpointSecret: string | null;
    readonly verifyBatchSize: number;
    readonly verifyMaxEvents: number;
    readonly exportBatchSize: number;
    /** Which CSV rendering rule an evidence bundle is written under — Phase 18. */
    readonly evidenceCsvProfile: RawConfig['AUDIT_EXPORT_CSV_PROFILE'];
  };
  /** The signature witness — Phase 16, ADR-0017. Null in a deployment without a key. */
  readonly signature: {
    readonly witnessSecret: string | null;
  };
  /** What a report export is bounded by (`docs/architecture/19-performance-and-scalability.md`). */
  readonly reporting: {
    readonly exportBatchSize: number;
    readonly exportMaxRows: number;
    /** Smaller than `exportMaxRows`: a PDF is assembled in memory rather than streamed. */
    readonly pdfMaxRows: number;
  };
  /** The render sandbox's resource caps (`14-preview-architecture.md` §5). */
  readonly preview: {
    readonly timeoutMs: number;
    readonly maxSourceBytes: number;
    readonly maxOutputBytes: number;
    readonly maxPages: number;
    readonly maxTextBytes: number;
    readonly maxArchiveEntries: number;
    readonly maxArchiveExpansionRatio: number;
    readonly maxPixels: number;
  };
  readonly rateLimit: { readonly windowSeconds: number; readonly maxRequests: number };
  /**
   * The outbound boundary — Phase 17, and the only configuration in the phase a tenant cannot
   * touch (`17-security-architecture.md` §6).
   */
  readonly outbound: {
    /** Empty means nothing is reachable, which is the default and the correct one. */
    readonly allowList: readonly string[];
    readonly allowInsecure: boolean;
    readonly maxResponseBytes: number;
  };
  /** Phase 18, and Phase 0.5's debt row 9: the port finally has an adapter behind a driver. */
  readonly observability: {
    readonly metricsDriver: RawConfig['METRICS_DRIVER'];
    /** Null under `NONE`; required by boot validation whenever the driver is real. */
    readonly metricsScrapeToken: string | null;
    readonly metricsMaxSeries: number;
    readonly metricsSampleIntervalMs: number;
  };
}

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

/**
 * Which of the three tenancy shapes the environment describes.
 *
 * The schema has already refused every combination but one, so this is a narrowing rather than a
 * decision — and the non-null assertions the alternative would need are exactly what that
 * validation exists to remove.
 */
function tenantSourceOf(raw: RawConfig): AppConfig['deployment']['tenants'] {
  if (raw.TENANT_CATALOGUE !== undefined) {
    return { source: 'INLINE', document: raw.TENANT_CATALOGUE };
  }
  if (raw.TENANT_CATALOGUE_PATH !== undefined) {
    return { source: 'FILE', path: raw.TENANT_CATALOGUE_PATH };
  }
  return { source: 'SINGLE', id: raw.TENANT_ID ?? '', slug: raw.TENANT_SLUG ?? '' };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty variable means "not set", not "set to the empty string". Both `.env.example` and
  // most deployment tooling write `FOO=` for an optional value left unfilled, and without this
  // the file we ship as a starting point refuses to boot on `STORAGE_ENDPOINT: Invalid url`.
  const provided = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = configSchema.safeParse(provided);
  if (!parsed.success) {
    // The message names the variables, never their values: an invalid secret must not be
    // echoed into a log line by the very error that rejected it.
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  return {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    deployment: { profile: raw.DEPLOYMENT_PROFILE, tenants: tenantSourceOf(raw) },
    app: { name: raw.APP_NAME, version: raw.APP_VERSION, port: raw.PORT },
    http: {
      corsOrigins: raw.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      openApiEnabled: raw.OPENAPI_ENABLED,
      openApiDocumentEnabled: raw.OPENAPI_DOCUMENT_ENABLED,
    },
    log: { level: raw.LOG_LEVEL },
    database: {
      url: raw.DATABASE_URL,
      migrationUrl: raw.DATABASE_MIGRATION_URL ?? null,
      poolSize: raw.DATABASE_POOL_SIZE,
      statementTimeoutMs: raw.DATABASE_STATEMENT_TIMEOUT_MS,
      maxTenantClients: raw.DATABASE_MAX_TENANT_CLIENTS,
    },
    redis: { url: raw.REDIS_URL },
    queue: {
      consumersEnabled: raw.QUEUE_CONSUMERS_ENABLED,
      outboxBatchSize: raw.OUTBOX_BATCH_SIZE,
      outboxPollIntervalMs: raw.OUTBOX_POLL_INTERVAL_MS,
    },
    auth: {
      issuer: raw.JWT_ISSUER,
      audience: raw.JWT_AUDIENCE,
      accessSecret: raw.JWT_ACCESS_SECRET,
      accessTtlSeconds: raw.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: raw.JWT_REFRESH_TTL_SECONDS,
      federationRedirectUri:
        raw.FEDERATION_REDIRECT_URI ??
        `${raw.WEB_BASE_URL.replace(/\/+$/, '')}/auth/federation/callback`,
    },
    storage: {
      driver: raw.STORAGE_DRIVER,
      bucket: raw.STORAGE_BUCKET ?? null,
      region: raw.STORAGE_REGION ?? null,
      endpoint: raw.STORAGE_ENDPOINT ?? null,
      signedUrlTtlSeconds: raw.STORAGE_SIGNED_URL_TTL_SECONDS,
      maxUploadBytes: raw.STORAGE_MAX_UPLOAD_BYTES,
      credentials:
        raw.STORAGE_ACCESS_KEY_ID !== undefined && raw.STORAGE_SECRET_ACCESS_KEY !== undefined
          ? {
              accessKeyId: raw.STORAGE_ACCESS_KEY_ID,
              secretAccessKey: raw.STORAGE_SECRET_ACCESS_KEY,
              sessionToken: raw.STORAGE_SESSION_TOKEN ?? null,
            }
          : null,
      forcePathStyle: raw.STORAGE_FORCE_PATH_STYLE,
      localRoot: raw.STORAGE_LOCAL_ROOT,
      publicUrl: raw.STORAGE_PUBLIC_URL ?? null,
      streamPartBytes: raw.STORAGE_STREAM_PART_BYTES,
      integrityBatchSize: raw.STORAGE_INTEGRITY_BATCH_SIZE,
      integrityMaxBytes: raw.STORAGE_INTEGRITY_MAX_BYTES,
    },
    audit: {
      readBufferSize: raw.AUDIT_READ_BUFFER_SIZE,
      readBufferMax: Math.max(raw.AUDIT_READ_BUFFER_MAX, raw.AUDIT_READ_BUFFER_SIZE),
      readFlushIntervalMs: raw.AUDIT_READ_FLUSH_INTERVAL_MS,
      checkpointSecret: raw.AUDIT_CHECKPOINT_SECRET ?? null,
      verifyBatchSize: raw.AUDIT_VERIFY_BATCH_SIZE,
      verifyMaxEvents: raw.AUDIT_VERIFY_MAX_EVENTS,
      exportBatchSize: raw.AUDIT_EXPORT_BATCH_SIZE,
      evidenceCsvProfile: raw.AUDIT_EXPORT_CSV_PROFILE,
    },
    signature: {
      witnessSecret: raw.SIGNATURE_WITNESS_SECRET ?? null,
    },
    reporting: {
      exportBatchSize: raw.REPORTING_EXPORT_BATCH_SIZE,
      exportMaxRows: raw.REPORTING_EXPORT_MAX_ROWS,
      pdfMaxRows: raw.REPORTING_PDF_MAX_ROWS,
    },
    providers: {
      search: raw.SEARCH_DRIVER,
      ocr: raw.OCR_DRIVER,
      mail: raw.MAIL_DRIVER,
      antivirus: raw.AV_DRIVER,
      office: raw.OFFICE_DRIVER,
    },
    ocr: {
      tesseractPath: raw.OCR_TESSERACT_PATH,
      languages: raw.OCR_LANGUAGES,
    },
    mail: {
      resendApiKey: raw.MAIL_RESEND_API_KEY ?? null,
      smtp: {
        host: raw.MAIL_SMTP_HOST ?? null,
        port: raw.MAIL_SMTP_PORT,
        security: raw.MAIL_SMTP_SECURITY,
        username: raw.MAIL_SMTP_USERNAME ?? null,
        password: raw.MAIL_SMTP_PASSWORD ?? null,
        // The web host, without its scheme: an EHLO name is a domain, and some relays refuse one
        // that does not resolve — which a container's random hostname never does.
        clientName: raw.MAIL_SMTP_CLIENT_NAME ?? new URL(raw.WEB_BASE_URL).hostname,
        rejectUnauthorized: raw.MAIL_SMTP_REJECT_UNAUTHORIZED,
      },
      resendEndpoint: raw.MAIL_RESEND_ENDPOINT,
      timeoutMs: raw.MAIL_TIMEOUT_MS,
      fromAddress: raw.MAIL_FROM_ADDRESS ?? null,
      fromName: raw.MAIL_FROM_NAME,
      // Trailing slashes removed once, here, so every link builder can concatenate.
      webBaseUrl: raw.WEB_BASE_URL.replace(/\/+$/, ''),
    },
    search: {
      debounceMs: raw.SEARCH_DEBOUNCE_MS,
      rebuildBatchSize: raw.SEARCH_REBUILD_BATCH_SIZE,
      recentLimit: raw.SEARCH_RECENT_LIMIT,
      maxBodyChars: raw.SEARCH_MAX_BODY_CHARS,
    },
    acl: {
      cacheTtlSeconds: raw.ACL_CACHE_TTL_SECONDS,
      maxSubjectEntries: raw.ACL_MAX_SUBJECT_ENTRIES,
    },
    mfa: {
      totpStepSeconds: raw.MFA_TOTP_STEP_SECONDS,
      totpDigits: raw.MFA_TOTP_DIGITS,
      totpSkewSteps: raw.MFA_TOTP_SKEW_STEPS,
      recoveryCodeCount: raw.MFA_RECOVERY_CODE_COUNT,
      maxFailedAttempts: raw.MFA_MAX_FAILED_ATTEMPTS,
      sealingKey: raw.MFA_TOTP_SEALING_KEY ?? null,
    },
    office: {
      libreofficePath: raw.OFFICE_LIBREOFFICE_PATH,
    },
    preview: {
      timeoutMs: raw.PREVIEW_RENDER_TIMEOUT_MS,
      maxSourceBytes: raw.PREVIEW_MAX_SOURCE_BYTES,
      maxOutputBytes: raw.PREVIEW_MAX_OUTPUT_BYTES,
      maxPages: raw.PREVIEW_MAX_PAGES,
      maxTextBytes: raw.PREVIEW_MAX_TEXT_BYTES,
      maxArchiveEntries: raw.PREVIEW_MAX_ARCHIVE_ENTRIES,
      maxArchiveExpansionRatio: raw.PREVIEW_MAX_ARCHIVE_EXPANSION_RATIO,
      maxPixels: raw.PREVIEW_MAX_PIXELS,
    },
    outbound: {
      allowList: raw.OUTBOUND_HTTP_ALLOWLIST.split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
      allowInsecure: raw.OUTBOUND_HTTP_ALLOW_INSECURE,
      maxResponseBytes: raw.OUTBOUND_HTTP_MAX_RESPONSE_BYTES,
    },
    rateLimit: {
      windowSeconds: raw.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: raw.RATE_LIMIT_MAX_REQUESTS,
    },
    observability: {
      metricsDriver: raw.METRICS_DRIVER,
      metricsScrapeToken: raw.METRICS_SCRAPE_TOKEN ?? null,
      metricsMaxSeries: raw.METRICS_MAX_SERIES,
      metricsSampleIntervalMs: raw.METRICS_SAMPLE_INTERVAL_MS,
    },
  };
}
