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
