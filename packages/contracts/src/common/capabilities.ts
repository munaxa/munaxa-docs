import { z } from 'zod';

import { ALL_PERMISSIONS, type PermissionKey } from '@edms/domain';

/**
 * What the caller may do to the resource they just fetched.
 *
 * The server computes this — capability, reach, state and confidentiality resolved
 * together — and the UI renders from it. The client never decides a permission and never
 * infers one from a status (`docs/architecture/08-permission-model.md` §7).
 */
export const capabilitiesSchema = z.record(
  z.enum(ALL_PERMISSIONS as [PermissionKey, ...PermissionKey[]]),
  z.boolean(),
);

export type Capabilities = Partial<Record<PermissionKey, boolean>>;

/** A resource representation that carries its own capability set. */
export function withCapabilities<TSchema extends z.ZodObject<z.ZodRawShape>>(schema: TSchema) {
  return schema.extend({ capabilities: capabilitiesSchema });
}

export function can(capabilities: Capabilities | undefined, permission: PermissionKey): boolean {
  return capabilities?.[permission] === true;
}
