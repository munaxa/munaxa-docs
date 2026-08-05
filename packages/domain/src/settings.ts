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
