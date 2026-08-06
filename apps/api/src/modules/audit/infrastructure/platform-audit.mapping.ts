import {
  ActorChannel,
  AuditOutcome,
  AuditSubjectType,
  asId,
  isDocsAuditAction,
  type ActorChannelKey,
  type AnyId,
  type AuditOutcomeKey,
  type AuditSubjectTypeKey,
  type DocsAuditAction,
  type TenantId,
  type UserId,
} from '@edms/domain';
import type { AuditRecord } from '@munaxa/interfaces';
import { unsafeId } from '@munaxa/types';
import type { CorrelationId, TenantId as PlatformTenantId } from '@munaxa/types';

import {
  GENESIS_HASH,
  isChainHashVersion,
  type ChainHashVersion,
} from '../../../core/audit/hash-chain';
import {
  toChainHashVersion,
  toPlatformFormatVersion,
  type DocsAuditFields,
} from '../../../core/audit/platform-canonical';
import type { AuditEventRecord } from '../application/ports';

/**
 * The one place `audit_event` and `AuditRecord` meet.
 *
 * Both directions are here together on purpose. The digest covers the row, and the Platform
 * computes the digest from the record — so if the two mappings ever disagreed about which field
 * carries which fact, the chain would still verify against itself while attesting something other
 * than what the table stores. Keeping them adjacent is the cheapest way to make that visible, and
 * `platform-canonical.spec.ts` is what proves the bytes still match `chainHash()`.
 *
 * ## Where each fact lives
 *
 * Most of the row maps onto the Platform's event envelope: the actor, the target, the source, the
 * correlation id. Four fields have nowhere to go and are carried verbatim under `payload.docs`,
 * for the reasons `DocsAuditFields` gives — chiefly that this product hashed `SUCCESS`/`DENIED`/
 * `FAILED` while the Platform's outcome is a lowercase union, and mapping between them would be a
 * guess about which token produced which digest.
 *
 * ## Why the read direction validates instead of casting
 *
 * `channel`, `subjectType` and `outcome` are narrow keys in the row and plain strings on the
 * Platform event. Casting them back would let a malformed record reach an `INSERT` that the
 * database then rejects at the end of a transaction that has already done work — or worse, reach a
 * column wide enough to take it. They are checked, and an unrecognised value throws before
 * anything is written.
 */
export interface PlatformAuditRecord extends AuditRecord<DocsAuditAction> {
  /** Always present: all three Docs formats are 901–903, and only format 1 omits the stamp. */
  readonly formatVersion: number;
}

/** The row as the Platform sees it. */
export function toPlatformRecord(row: AuditEventRecord): PlatformAuditRecord {
  const version = row.chainHashVersion;
  if (!isChainHashVersion(version)) {
    throw new Error(
      `Audit row ${row.id} carries chain hash version ${version}, which this build cannot verify.`,
    );
  }
  const docs: DocsAuditFields = {
    outcome: row.outcome,
    reason: row.reason,
    apiClientId: row.apiClientId,
    payload: row.payload,
  };
  return {
    id: row.id,
    event: {
      name: row.action,
      occurredAt: row.occurredAt.getTime(),
      tenantId: unsafeId<PlatformTenantId>(row.tenantId),
      correlationId: unsafeId<CorrelationId>(row.correlationId),
      // The Platform-shaped projection, for a Platform-shaped query. Never hashed by the Docs
      // formats — those read `docs.outcome`, which is the token that was actually written.
      outcome: row.outcome === AuditOutcome.SUCCESS ? 'success' : 'denied',
      severity: 'info',
      ...(row.actorId === null
        ? {}
        : {
            actor: {
              id: row.actorId,
              kind: 'user',
              ...(row.onBehalfOfId === null ? {} : { onBehalfOf: row.onBehalfOfId }),
            },
          }),
      target: { id: row.subjectId, type: row.subjectType },
      source: {
        component: row.channel,
        ...(row.ipAddress === null ? {} : { ipAddress: row.ipAddress }),
        ...(row.userAgent === null ? {} : { userAgent: row.userAgent }),
      },
      payload: { docs },
    },
    // The row has one timestamp. The writer holds `recordedAt` equal to `occurredAt` precisely so
    // this stays lossless — see `createDocsAuditService`.
    recordedAt: row.occurredAt.getTime(),
    sequence: row.sequence,
    previousHash: row.previousHash === GENESIS_HASH ? null : row.previousHash,
    hash: row.hash,
    formatVersion: toPlatformFormatVersion(version),
  };
}

/** The sealed record as a row. Every field the digest covers comes from the record, not beside it. */
export function toAuditEventRecord(record: AuditRecord<DocsAuditAction>): AuditEventRecord {
  const { event } = record;
  const docs = docsFieldsOf(record);

  return {
    id: asId<AnyId>(record.id),
    tenantId: asId<TenantId>(event.tenantId),
    sequence: BigInt(record.sequence),
    occurredAt: new Date(event.occurredAt),
    actorId: event.actor === undefined ? null : asId<UserId>(event.actor.id),
    onBehalfOfId:
      event.actor?.onBehalfOf === undefined ? null : asId<UserId>(event.actor.onBehalfOf),
    channel: requireChannel(event.source?.component, record.id),
    action: requireAction(event.name, record.id),
    subjectType: requireSubjectType(event.target?.type, record.id),
    subjectId: asId<AnyId>(requireTarget(event.target, record.id).id),
    outcome: requireOutcome(docs.outcome, record.id),
    payload: docs.payload,
    reason: docs.reason,
    correlationId: event.correlationId,
    ipAddress: event.source?.ipAddress ?? null,
    userAgent: event.source?.userAgent ?? null,
    apiClientId: docs.apiClientId === null ? null : asId<AnyId>(docs.apiClientId),
    hash: record.hash,
    // `char(64)`, not nullable: a tenant's first record carries 64 zeros where the Platform
    // carries `null`, and the Docs formats hash it as `previousHash ?? GENESIS_HASH`. The two
    // representations therefore produce the same digest, and only one reaches the column.
    previousHash: record.previousHash ?? GENESIS_HASH,
    chainHashVersion: requireChainHashVersion(record.formatVersion, record.id),
  };
}

/** The four fields the Platform event cannot carry, narrowed to what a row needs. */
interface DocsRecordFields extends DocsAuditFields {
  readonly payload: Readonly<Record<string, unknown>>;
}

function docsFieldsOf(record: AuditRecord<DocsAuditAction>): DocsRecordFields {
  const wrapper = record.event.payload as { docs?: DocsAuditFields } | undefined;
  const fields = wrapper?.docs;
  if (fields === undefined) {
    throw new Error(`Audit record ${record.id} is missing its Munaxa Docs field set.`);
  }
  if (
    typeof fields.payload !== 'object' ||
    fields.payload === null ||
    Array.isArray(fields.payload)
  ) {
    throw new Error(`Audit record ${record.id} carries a payload that is not an object.`);
  }
  return { ...fields, payload: fields.payload as Readonly<Record<string, unknown>> };
}

function requireTarget(
  target: { readonly id: string; readonly type: string } | undefined,
  id: string,
): { readonly id: string; readonly type: string } {
  if (target === undefined) {
    throw new Error(`Audit record ${id} has no subject; every audit event is about something.`);
  }
  return target;
}

function requireAction(value: string, id: string): DocsAuditAction {
  if (!isDocsAuditAction(value)) {
    throw new Error(
      `Audit record ${id} carries action '${value}', which is not in the vocabulary.`,
    );
  }
  return value;
}

function requireChannel(value: string | undefined, id: string): ActorChannelKey {
  if (value !== undefined && (CHANNELS as readonly string[]).includes(value)) {
    return value as ActorChannelKey;
  }
  throw new Error(`Audit record ${id} carries channel '${String(value)}', which is not a channel.`);
}

function requireSubjectType(value: string | undefined, id: string): AuditSubjectTypeKey {
  if (value !== undefined && (SUBJECT_TYPES as readonly string[]).includes(value)) {
    return value as AuditSubjectTypeKey;
  }
  throw new Error(`Audit record ${id} carries subject type '${String(value)}', which is unknown.`);
}

function requireOutcome(value: string, id: string): AuditOutcomeKey {
  if ((OUTCOMES as readonly string[]).includes(value)) {
    return value as AuditOutcomeKey;
  }
  throw new Error(`Audit record ${id} carries outcome '${value}', which is not an outcome.`);
}

/**
 * The stored `chain_hash_version`, recovered from the format that sealed the record.
 *
 * A record with no `formatVersion` was sealed by Platform canonical format 1, which is not one of
 * this product's three. Writing it would put a row in an append-only table under a digest no Docs
 * verifier can reproduce, so it is refused here rather than discovered years later.
 */
function requireChainHashVersion(formatVersion: number | undefined, id: string): ChainHashVersion {
  if (formatVersion === undefined) {
    throw new Error(
      `Audit record ${id} was sealed by the platform's default canonical format, not a Munaxa ` +
        'Docs format. Refusing to write a row this product cannot verify.',
    );
  }
  const version = toChainHashVersion(formatVersion);
  if (!isChainHashVersion(version)) {
    throw new Error(`Audit record ${id} was sealed by unknown canonical format ${formatVersion}.`);
  }
  return version;
}

const CHANNELS = Object.values(ActorChannel);
const SUBJECT_TYPES = Object.values(AuditSubjectType);
const OUTCOMES = Object.values(AuditOutcome);
