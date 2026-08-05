/**
 * The settings catalogue — the single definition of every tenant-configurable setting.
 *
 * A setting that is not here does not exist. The API may not read one that is undeclared, and
 * the web client may not invent one, for the same reason the permission catalogue works that
 * way: configuration that is only a string key is configuration nobody can enumerate, type, or
 * safely change.
 *
 * Each definition carries its own parser rather than deferring to a schema library, so this
 * file stays pure and importable from the API, the workers and the browser alike.
 *
 * **A stored value that no longer parses falls back to the default.** Settings are read on
 * paths that must not fail — a malformed row left by an older release, or by a hand-edited
 * `jsonb`, must not take an endpoint down. The reader logs it; the product keeps working.
 */

export interface SettingDefinition<TValue> {
  readonly key: string;
  readonly defaultValue: TValue;
  /** What this controls, in the words an administration screen would use. */
  readonly description: string;
  /**
   * Which control renders it, so a screen needs no per-key mapping of its own.
   *
   * Stated rather than inferred from `typeof defaultValue`: a string setting with a fixed set of
   * values and one without are the same JavaScript type and different controls, and a screen that
   * guessed would offer free text where only two values are legal.
   */
  readonly kind: 'string' | 'integer' | 'boolean' | 'choice';
  /**
   * The values a `choice` setting accepts.
   *
   * Declared here rather than left inside `parse`'s closure, because a form has to validate against
   * the same set the API does. The alternative is restating it in the screen — a second source of
   * truth for what is legal — or interrogating the parser, which is worse: it makes the bounds
   * discoverable only by guessing at them.
   */
  readonly allowed?: readonly string[];
  /** The range an `integer` setting accepts, for the same reason. */
  readonly bounds?: { readonly min: number; readonly max: number };
  /** Narrows an untrusted stored value. `null` means "not usable — take the default". */
  parse(raw: unknown): TValue | null;
}

/**
 * The key type is generic so each definition keeps its *literal* key.
 *
 * Widening it to `string` would make `SettingKey` just `string`, and a catalogue whose key type
 * is `string` narrows nothing and catches no typo.
 */
function stringSetting<const TKey extends string>(
  key: TKey,
  defaultValue: string,
  description: string,
  allowed?: readonly string[],
): SettingDefinition<string> & { readonly key: TKey } {
  return {
    key,
    defaultValue,
    description,
    kind: allowed ? 'choice' : 'string',
    ...(allowed && { allowed }),
    parse(raw) {
      if (typeof raw !== 'string') {
        return null;
      }
      const value = raw.trim();
      if (value.length === 0) {
        return null;
      }
      return !allowed || allowed.includes(value) ? value : null;
    },
  };
}

/**
 * A string setting whose empty value is a real answer rather than "unset".
 *
 * `stringSetting` treats blank as no value and falls back to the default, which is right for a
 * locale or a timezone — there is no such thing as an empty one. It is wrong for a setting whose
 * whole point is that a tenant may have nothing to put there: a logo URL that cannot be cleared
 * is a logo a tenant can add and never remove.
 */
function optionalStringSetting<const TKey extends string>(
  key: TKey,
  defaultValue: string,
  description: string,
): SettingDefinition<string> & { readonly key: TKey } {
  return {
    key,
    defaultValue,
    description,
    kind: 'string',
    parse(raw) {
      return typeof raw === 'string' ? raw.trim() : null;
    },
  };
}

function integerSetting<const TKey extends string>(
  key: TKey,
  defaultValue: number,
  description: string,
  bounds: { readonly min: number; readonly max: number },
): SettingDefinition<number> & { readonly key: TKey } {
  return {
    key,
    defaultValue,
    description,
    kind: 'integer',
    bounds,
    parse(raw) {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        return null;
      }
      // Out of bounds is rejected rather than clamped: a stored 0 where the minimum is 8 is
      // someone's mistake, and silently honouring the nearest legal value hides it.
      return raw >= bounds.min && raw <= bounds.max ? raw : null;
    },
  };
}

function booleanSetting<const TKey extends string>(
  key: TKey,
  defaultValue: boolean,
  description: string,
): SettingDefinition<boolean> & { readonly key: TKey } {
  return {
    key,
    defaultValue,
    description,
    kind: 'boolean',
    parse(raw) {
      return typeof raw === 'boolean' ? raw : null;
    },
  };
}

/**
 * Every setting the product knows.
 *
 * Defaults are the product's opinion, not a placeholder: a tenant that changes nothing gets a
 * correct and defensible configuration.
 */
export const Settings = {
  DEFAULT_LOCALE: stringSetting(
    'locale.default',
    'en',
    'The language used when a request states no preference, and for scheduled work that acts for nobody.',
    ['en', 'ar'],
  ),

  TIMEZONE: stringSetting(
    'locale.timezone',
    'UTC',
    'The timezone dates are rendered in, and the one retention and reporting boundaries are computed against.',
  ),

  PASSWORD_MINIMUM_LENGTH: integerSetting(
    'security.password.minimumLength',
    12,
    'The shortest password the tenant accepts when one is set or changed.',
    // Never below NIST SP 800-63B's floor of 8, however a tenant configures it.
    { min: 8, max: 128 },
  ),

  PASSWORD_FORBID_IDENTIFIERS: booleanSetting(
    'security.password.forbidIdentifiers',
    true,
    'Rejects a password containing the account’s own email address or display name.',
  ),

  SESSION_IDLE_TIMEOUT_MINUTES: integerSetting(
    'security.session.idleTimeoutMinutes',
    480,
    'How long a session may sit unused before it must be re-established.',
    { min: 5, max: 10_080 },
  ),

  AUDIT_READS_ABOVE_CONFIDENTIALITY_RANK: integerSetting(
    'audit.readEventsAboveRank',
    0,
    'Documents at or above this confidentiality rank record an event when they are viewed.',
    { min: 0, max: 100 },
  ),

  /**
   * How long a deleted document stays restorable before it becomes eligible for disposition.
   *
   * ADR-0010 §4 says permanent destruction happens only through retention, and Phase 10's brief
   * says drafts may be permanently deleted. This is where the two meet: a document that never held
   * a number and names no retention policy has nothing to compute a disposition date from, so the
   * recycle-bin window *is* its retention period. It is a tenant setting rather than a constant
   * because "how long is the undo" is a business decision, and thirty days is the product's
   * opinion rather than a placeholder.
   *
   * A numbered document is never disposed of on this clock. Its frozen policy decides, however
   * long ago somebody deleted it.
   */
  RETENTION_RECYCLE_BIN_DAYS: integerSetting(
    'retention.recycleBinDays',
    30,
    'How long an unnumbered deleted document stays in the recycle bin before it may be purged.',
    { min: 1, max: 3_650 },
  ),

  /**
   * How long a blob stays in storage after its last reference goes.
   *
   * ADR-0010 §8's grace period, made a number. It exists because a reference count reaching zero
   * and a restore are separated by however long somebody takes to notice: without the delay, a
   * delete followed by a restore an hour later would restore a document whose bytes the sweep had
   * already removed, and the row would point at nothing.
   */
  RETENTION_BLOB_GRACE_DAYS: integerSetting(
    'retention.blobGraceDays',
    7,
    'How long an unreferenced file stays in storage before the retention sweep deletes it.',
    { min: 0, max: 365 },
  ),

  /**
   * Whether a delegation waits for somebody's agreement before it is in force.
   *
   * `07-workflow-architecture.md` §4 does not require an approval, and the phase brief does — so
   * it is a setting rather than a constant, and the product's opinion is that it is required. A
   * delegation moves an approval authority to somebody else; the tenants that need one at all are
   * the tenants with a control environment, and a control somebody grants themselves silently is
   * not one.
   *
   * Turning it off makes an ordinary delegation active on creation. It does *not* make it
   * unaudited, and it does not turn every delegation into an emergency one: the kind still records
   * which path the row took, and `delegation.emergencyMaximumHours` still binds the emergency one.
   */
  DELEGATION_REQUIRE_APPROVAL: booleanSetting(
    'delegation.requireApproval',
    true,
    'A delegation waits for the delegator’s manager, or another delegation administrator, before it is in force.',
  ),

  /**
   * Whether an authority somebody already holds by delegation may be delegated onward.
   *
   * §4's row verbatim: "a delegated authority may not be re-delegated by default; a tenant setting
   * allows one hop, never a cycle". This is that setting. The hop count is not configurable and
   * the cycle refusal is not configurable — both are in `delegation.ts` as arithmetic, because a
   * tenant that could raise the hop count could build a chain nobody can read, and no tenant has a
   * legitimate need for a cycle.
   */
  DELEGATION_ALLOW_CHAINING: booleanSetting(
    'delegation.allowChaining',
    false,
    'Somebody acting under a delegation may delegate that authority onward, exactly one further hop.',
  ),

  /**
   * The longest ordinary delegation the tenant accepts.
   *
   * §4 refuses open-ended delegations, and "bounded" needs a number. Ninety days is a quarter — a
   * secondment, a parental leave, a long project — and a delegation meant to outlast one is an
   * arrangement that should be a role change instead.
   */
  DELEGATION_MAXIMUM_DAYS: integerSetting(
    'delegation.maximumDays',
    90,
    'The longest period an ordinary delegation may cover.',
    { min: 1, max: 365 },
  ),

  /**
   * The longest emergency delegation the tenant accepts.
   *
   * Much shorter than the ordinary maximum, deliberately, and that ratio is the whole design of
   * the emergency path: it buys the bypass of an approval with a period short enough that the
   * approval can happen afterwards. Seventy-two hours covers a weekend plus the Monday somebody
   * discovers the problem.
   */
  DELEGATION_EMERGENCY_MAXIMUM_HOURS: integerSetting(
    'delegation.emergencyMaximumHours',
    72,
    'The longest period an emergency delegation may cover, declared without approval.',
    { min: 1, max: 720 },
  ),

  CHECKOUT_EXPIRY_HOURS: integerSetting(
    'documents.checkoutExpiryHours',
    // Three working days, roughly: long enough to edit a real document offline over a weekend,
    // short enough that a forgotten lock does not hold a controlled document for a quarter.
    72,
    'How long a check-out lock lasts before any later operation may sweep it aside as expired.',
    { min: 1, max: 8_760 },
  ),

  // --- Notifications (Phase 12) ---------------------------------------------------------------

  /**
   * The three values 18 §6 calls "tenant branding", for the one surface that cannot read a
   * stylesheet: HTML email.
   *
   * §6 names `platform/themes/docs/brand.ts` as the source of the hex, and the default below is
   * that file's `brand.color.DEFAULT` for the Docs theme, recorded here with its provenance
   * rather than imported. The API depends on no `@munaxa/*` package — it renders no UI — and
   * pulling the design system into a NestJS process to read one string would add a React peer
   * dependency to avoid a default. Making it a *setting* is also the stronger answer: a tenant
   * with its own brand gets its own colour, which a fixed import could never have given.
   *
   * This is the only raw hex in this repository, and §6 is the sentence that permits it.
   */
  NOTIFICATION_BRAND_NAME: stringSetting(
    'notification.brand.name',
    'Munaxa Docs',
    'The name shown in the header and footer of notification emails.',
  ),

  NOTIFICATION_BRAND_COLOR: stringSetting(
    'notification.brand.color',
    '#6B8E62',
    'The header colour of notification emails, as `#RRGGBB`.',
  ),

  NOTIFICATION_BRAND_LOGO_URL: optionalStringSetting(
    'notification.brand.logoUrl',
    // Empty means "render the name as a wordmark". A logo has to be an absolute URL a mail
    // client can fetch without a session, and most tenants do not have one hosted — so blank is
    // the default *and* a value a tenant may return to, which is why this one is optional.
    '',
    'An absolute URL to the logo shown in notification emails, or blank for a text wordmark.',
  ),

  /**
   * The hour of the tenant's own day a daily or weekly digest is delivered at.
   *
   * Not midnight: a digest exists to be read, and one delivered at 00:05 competes with
   * everything that arrived overnight. Resolved against `locale.timezone`, because the cron that
   * fires the collection fires in one zone and a tenant lives in its own.
   */
  NOTIFICATION_DIGEST_HOUR: integerSetting(
    'notification.digestHour',
    7,
    'The local hour a daily or weekly notification digest is delivered at.',
    { min: 0, max: 23 },
  ),

  /**
   * How many permanent refusals suppress an address — 18 §7's "repeated hard bounces".
   *
   * Three rather than one, because a provider occasionally reports a transient condition as
   * permanent, and cutting somebody off from every notification in the product on one such
   * report is a worse failure than three wasted sends. A tenant running its own mail server
   * with reliable classification may set it to one.
   */
  NOTIFICATION_BOUNCE_THRESHOLD: integerSetting(
    'notification.bounceThreshold',
    3,
    'How many permanent delivery failures suppress an email address.',
    { min: 1, max: 20 },
  ),

  /**
   * How long a bulk operation's coalescing window stays open — 18 §7's last row.
   *
   * "Bulk operations emit one summary notification, never one per object", and the window is
   * what decides an operation has finished producing objects. Long enough that a nightly sweep
   * over five hundred schedules lands in one summary; short enough that a person waiting on a
   * single one is not left wondering.
   */
  NOTIFICATION_COALESCE_MINUTES: integerSetting(
    'notification.coalesceMinutes',
    15,
    'How long notifications from one bulk operation are collected before one summary is sent.',
    { min: 1, max: 1_440 },
  ),

  // --- Phase 16: bulk operations ------------------------------------------------------------

  /**
   * The most objects one bulk request may name.
   *
   * A hard ceiling on the *request*, not on the work: a client with six thousand documents to
   * restore sends six requests. It exists because the alternative is an unbounded array in a
   * request body, and every cost this phase reasons about — the reach resolution per object, the
   * audit chain's per-tenant advisory lock, the transaction per object — is linear in it. A number
   * an operator can lower when a tenant's chain is the bottleneck is worth more than a constant
   * chosen here.
   *
   * Five thousand is 19 §5's own example ("one large tenant's bulk import"), so the default is the
   * figure the performance document already reasons about rather than a fresh opinion.
   */
  BULK_MAX_OBJECTS: integerSetting(
    'bulk.maxObjects',
    5_000,
    'The most documents or tasks one bulk request may name.',
    { min: 1, max: 50_000 },
  ),

  /**
   * Above this many objects, a bulk operation is queued instead of run in the request.
   *
   * The two paths are the *same executor* over the same per-object function — what changes is who
   * is waiting. Below the threshold the caller gets the per-object outcomes back and can act on
   * them; above it they get a `202` and an operation to poll, because a request holding a
   * connection open for four thousand transactions is a request that dies to a proxy timeout with
   * half its work committed and no way to find out which half.
   *
   * Fifty is deliberately low. The synchronous path exists for "I selected a screenful and pressed
   * the button", which is what 16 §5's drag-select produces; anything larger is an import.
   */
  BULK_SYNCHRONOUS_LIMIT: integerSetting(
    'bulk.synchronousLimit',
    50,
    'Bulk operations larger than this are queued and polled rather than run in the request.',
    { min: 1, max: 1_000 },
  ),

  /**
   * How many jobs of one tenant a lane may run at once — 19 §5's fairness claim, made true.
   *
   * That section has claimed since Phase 0 that "per-tenant concurrency caps stop one large
   * tenant's bulk import from monopolising a pool", and until Phase 16 the claim was false:
   * `QueueDefinition.concurrency` is per *lane*, so one tenant's five thousand jobs fill every
   * slot on it and every other tenant waits. Nothing had produced enough jobs for anyone to
   * notice. A bulk import is what makes it matter, so the lane that carries one declares a cap and
   * the adapter enforces it — a job over the cap is re-queued with a short delay rather than
   * failed, because "wait your turn" is not an error.
   */
  BULK_TENANT_CONCURRENCY: integerSetting(
    'bulk.tenantConcurrency',
    2,
    'How many bulk jobs of one tenant may run at once on the bulk lane.',
    { min: 1, max: 64 },
  ),

  // --- Phase 16: the feature flags the brief asks for ----------------------------------------
  //
  // Here rather than in configuration, because 21's entitlements are ADR-0012's and Phase 21's and
  // these are not entitlements: they are a tenant's own answer to "do we work this way". A tenant
  // in a regulated industry turns signatures on and cannot turn bulk approval on; a tenant using
  // this as a drawing register turns templates off. Each is read through `SETTINGS_READER` at the
  // use case, so turning one off refuses the operation rather than merely hiding its button.

  /** Whether this tenant performs bulk operations at all. */
  FEATURE_BULK_OPERATIONS: booleanSetting(
    'feature.bulkOperations',
    true,
    'Whether documents may be uploaded, edited, approved, restored or exported in bulk.',
  ),

  /**
   * Whether bulk *approval* is available, separately from the other four.
   *
   * Its own flag rather than a mode of the one above, and the separation is the interesting part:
   * the other four bulk operations are administrative convenience, and this one decides regulated
   * records. A quality manager who wants drag-select in the folder browser and wants every
   * approval to be a deliberate, individual act has a coherent position, and one flag would make
   * it unexpressible.
   */
  FEATURE_BULK_APPROVAL: booleanSetting(
    'feature.bulkApproval',
    true,
    'Whether approval tasks may be decided in bulk, rather than one at a time.',
  ),

  FEATURE_DOCUMENT_TEMPLATES: booleanSetting(
    'feature.documentTemplates',
    true,
    'Whether documents may be created from controlled templates.',
  ),

  FEATURE_ELECTRONIC_SIGNATURES: booleanSetting(
    'feature.electronicSignatures',
    true,
    'Whether a revision may be signed, and signatures verified.',
  ),

  /**
   * Whether signing asks for the signer's credentials again.
   *
   * Default on, and the default is the whole point: 21 CFR Part 11 §11.200 requires a signature
   * to use at least two distinct identification components, and a session cookie is one component
   * that was checked at sign-in and has been sitting in a browser since. A tenant that is not
   * operating under such a regime may turn it off; a tenant that is must not, and the setting's
   * description says so rather than leaving it to be discovered.
   */
  SIGNATURE_REQUIRE_REAUTHENTICATION: booleanSetting(
    'signature.requireReauthentication',
    true,
    'Whether signing asks for the signer’s password again. Required by 21 CFR Part 11 §11.200.',
  ),

  // --- Phase 17: the integration platform -------------------------------------------------

  /**
   * Whether this tenant may authenticate machine callers at all.
   *
   * Read at the **authenticator**, not at the screen that mints a key: a tenant that turns this
   * off wants every existing key to stop working now, not to stop being creatable. The keys
   * survive, disabled by the flag rather than deleted, so turning it back on does not mean
   * re-issuing credentials to every integration somebody built.
   */
  FEATURE_API_CLIENTS: booleanSetting(
    'feature.apiClients',
    true,
    'Whether machine callers may authenticate with an API key.',
  ),

  FEATURE_WEBHOOKS: booleanSetting(
    'feature.webhooks',
    true,
    'Whether domain events are delivered to this tenant’s outbound webhook endpoints.',
  ),

  /**
   * Whether a tenant's users may sign in through its identity provider.
   *
   * Deliberately separate from whether a provider is *configured*. An administrator setting one up
   * needs to save it, test the discovery document and map the roles before anybody signs in
   * through it, and a flag that meant "configured" would make the half-configured state the live
   * one. Local passwords are unaffected either way — 17 §2 lists federation beside local
   * credentials rather than instead of them.
   */
  FEATURE_FEDERATION: booleanSetting(
    'feature.federation',
    false,
    'Whether users may sign in through this tenant’s identity provider.',
  ),

  /** Whether the audit sink streams at all — 13 §6's "optional per tenant", as a flag. */
  FEATURE_AUDIT_STREAMING: booleanSetting(
    'feature.auditStreaming',
    false,
    'Whether the audit trail is available to an external collector, by pull cursor or by push.',
  ),

  /**
   * How many times a webhook delivery is attempted before it is dead-lettered.
   *
   * The floor is 1 rather than 0 — an endpoint configured to receive nothing is a disabled
   * endpoint, and expressing it here would give two ways to say one thing. The ceiling is 12,
   * which with the capped exponential backoff is a little over a day of retrying: long enough to
   * cover a receiver's weekend outage, short enough that a decommissioned URL stops costing
   * requests within one.
   */
  WEBHOOK_MAX_ATTEMPTS: integerSetting(
    'webhook.maxAttempts',
    8,
    'How many times an undelivered webhook is retried before it is dead-lettered.',
    { min: 1, max: 12 },
  ),

  /**
   * How long a receiver has to answer before the attempt is a failure.
   *
   * Short on purpose. A webhook consumer that needs longer than this is doing work in its handler
   * that belongs in its own queue, and waiting for it holds a delivery slot that everybody else's
   * endpoints are behind.
   */
  WEBHOOK_TIMEOUT_SECONDS: integerSetting(
    'webhook.timeoutSeconds',
    10,
    'How long an endpoint has to acknowledge a delivery before the attempt fails.',
    { min: 1, max: 60 },
  ),

  /**
   * How many events one audit-stream page may carry.
   *
   * Bounded like every other page in the product, and for one extra reason here: a collector
   * asking for a million rows in one request would hold a transaction open across the whole
   * range, and the trail is the one table in the product with a per-tenant advisory lock in front
   * of its writes.
   */
  AUDIT_STREAM_PAGE_SIZE: integerSetting(
    'audit.streamPageSize',
    500,
    'How many audit events one page of the stream carries.',
    { min: 25, max: 2_000 },
  ),
} as const;

export type SettingKey = (typeof Settings)[keyof typeof Settings]['key'];

export const ALL_SETTINGS: readonly SettingDefinition<unknown>[] = Object.freeze(
  Object.values(Settings) as SettingDefinition<unknown>[],
);

const SETTING_BY_KEY: ReadonlyMap<string, SettingDefinition<unknown>> = new Map(
  ALL_SETTINGS.map((definition) => [definition.key, definition]),
);

/** Narrows an untrusted key — an API filter, a stored `jsonb` property — to the catalogue. */
export function settingFor(key: string): SettingDefinition<unknown> | null {
  return SETTING_BY_KEY.get(key) ?? null;
}

export function isSettingKey(key: string): key is SettingKey {
  return SETTING_BY_KEY.has(key);
}

export interface ResolvedSettings {
  /** Complete and valid: every declared setting, never null, never missing. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Declared keys whose stored value could not be used, and so took the default. */
  readonly fellBack: readonly string[];
  /** Stored keys the catalogue does not declare — an older release, or a hand edit. */
  readonly unrecognised: readonly string[];
}

/**
 * Resolves a stored bag of values against the catalogue.
 *
 * Unknown keys are dropped and unparseable values fall back to their default, so `values` is
 * always complete and always valid — callers never branch on "was it set?".
 *
 * The diagnostics are returned rather than left for the caller to infer by comparing stored
 * against resolved. That comparison looks obvious and is wrong for any setting whose value is
 * not a primitive, where equality is not identity.
 */
export function resolveSettings(stored: Readonly<Record<string, unknown>>): ResolvedSettings {
  const values: Record<string, unknown> = {};
  const fellBack: string[] = [];

  for (const definition of ALL_SETTINGS) {
    const raw = stored[definition.key];
    const parsed = raw === undefined ? null : definition.parse(raw);
    if (raw !== undefined && parsed === null) {
      fellBack.push(definition.key);
    }
    values[definition.key] = parsed ?? definition.defaultValue;
  }

  const unrecognised = Object.keys(stored).filter((key) => !SETTING_BY_KEY.has(key));
  return { values, fellBack, unrecognised };
}
