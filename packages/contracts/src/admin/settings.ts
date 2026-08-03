import { z } from 'zod';

import { ALL_SETTINGS, type SettingKey } from '@edms/domain';

/**
 * The tenant settings screen.
 *
 * The catalogue in `@edms/domain` is the only definition of what a setting is, so the wire shape
 * is derived from it rather than restated: `settingKeySchema` is built from `ALL_SETTINGS`, and a
 * key outside it is refused before it reaches the repository — which refuses it again, because a
 * value nothing can read back is only clutter.
 */
export const settingKeySchema = z.enum(
  ALL_SETTINGS.map((definition) => definition.key) as [SettingKey, ...SettingKey[]],
);

/**
 * One setting, resolved.
 *
 * `value` and `defaultValue` travel together so the screen can show "changed from the default"
 * without a second source of truth, and `isOverridden` is computed by the server rather than by
 * comparing them in the client — equality is not identity for a non-primitive value, and a
 * client that guessed would be wrong for exactly the settings that matter most.
 */
export const settingSchema = z.object({
  key: settingKeySchema,
  description: z.string(),
  value: z.unknown(),
  defaultValue: z.unknown(),
  isOverridden: z.boolean(),
  /** What kind of control renders it, so the screen needs no per-key mapping. */
  kind: z.enum(['string', 'integer', 'boolean', 'choice']),
  /** Present for a choice setting. */
  allowed: z.array(z.string()).optional(),
  /** Present for an integer setting. Bounds are the catalogue's, not the screen's. */
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

export const settingsResponseSchema = z.object({
  data: z.array(settingSchema),
  /**
   * Stored keys the catalogue no longer declares, and declared keys whose stored value could not
   * be used. Surfaced rather than swallowed: a setting silently falling back to its default is a
   * tenant running on a configuration they did not choose.
   */
  diagnostics: z.object({
    fellBack: z.array(z.string()),
    unrecognised: z.array(z.string()),
  }),
});

/**
 * A write.
 *
 * One key per request rather than the whole bag: `jsonb_set` merges in the database, so two
 * administrators saving different settings at the same time cannot drop each other's change —
 * which a read-modify-write of a whole bag would do, and would do silently.
 */
export const updateSettingSchema = z.object({
  key: settingKeySchema,
  /** Validated against the key's own parser; a value the catalogue rejects is a 422, not a default. */
  value: z.unknown(),
});

/** Returns a setting to the product's default by removing the tenant's override. */
export const resetSettingSchema = z.object({
  key: settingKeySchema,
});

export type Setting = z.infer<typeof settingSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
export type UpdateSettingBody = z.infer<typeof updateSettingSchema>;
export type ResetSettingBody = z.infer<typeof resetSettingSchema>;
