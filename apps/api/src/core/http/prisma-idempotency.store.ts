import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { uuidv7 } from '@edms/utils';

import { TenantDatabase } from '../prisma/tenant-database';
import type { IdempotencyClaim, IdempotencyStore, IdempotentRequest } from './idempotency.store';

/**
 * How long a stored answer is replayed. The same day Redis kept it for before D-20.
 */
export const IDEMPOTENCY_REPLAY_SECONDS = 86_400;

/**
 * How long a claim holds without an answer before it is presumed abandoned.
 *
 * A claim outlives its request only when the process running it died mid-request; the lease is what
 * lets the key be used again without an operator. It must exceed any mutating request's real running
 * time — past it, a retry would perform the request a second time — and every mutation this API
 * performs in a request is milliseconds to seconds (anything long is queued and answered at once).
 */
export const IDEMPOTENCY_LEASE_SECONDS = 120;

/** How many expired rows one claim sweeps, so the table stays bounded without a job of its own. */
const SWEEP_BATCH = 50;

/**
 * The idempotency record in the tenant's own database — RC validation, D-20.
 *
 * ## The claim is the INSERT
 *
 * `uq_idempotency_request` is unique per tenant, key, method, path and body hash. Every request
 * carrying a key inserts its row `IN_PROGRESS` before it runs, and PostgreSQL decides which insert
 * wins: a concurrent insert of the same row waits for the first transaction and then conflicts. The
 * conflict takes the row over only if it is dead — its replay window has closed, or it is a claim
 * whose lease ran out because its process died — so exactly one request is ever `OWNER`, from any
 * number of processes. No lock is held in memory, and nothing in Redis is involved: a Redis loss
 * neither releases a claim nor forgets an answer.
 *
 * Every time is the database's `now()`, so two API instances with skewed clocks agree on whether a
 * lease has run out.
 *
 * ## One short transaction per step
 *
 * The claim, the completion and the release each commit on their own. The claim must be visible to
 * other processes *before* the request runs, which is the whole point, so it cannot share the
 * request's transaction; and holding a transaction open across the request would cost a pooled
 * connection per request in flight.
 */
@Injectable()
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(@Inject(TenantDatabase) private readonly databases: TenantDatabase) {}

  async claim(request: IdempotentRequest): Promise<IdempotencyClaim> {
    // Twice at most: a row can vanish between the conflict and the read when its owner fails and
    // releases it in that instant, and the second attempt then inserts. A third vanishing in a row
    // is answered as in progress rather than looped on.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      const outcome = await this.databases.withTenant(request.tenantId, async (tx) => {
        const won = await tx.$queryRaw<{ owner_token: string | null }[]>`
          INSERT INTO idempotency_key (
            id, tenant_id, key, request_method, request_path, request_hash,
            state, owner_token, lease_expires_at, expires_at
          ) VALUES (
            ${uuidv7()}::uuid, ${request.tenantId}::uuid, ${request.key}, ${request.method},
            ${request.path}, ${request.bodyHash},
            'IN_PROGRESS', ${token}::uuid,
            now() + make_interval(secs => ${IDEMPOTENCY_LEASE_SECONDS}::int),
            now() + make_interval(secs => ${IDEMPOTENCY_REPLAY_SECONDS}::int)
          )
          ON CONFLICT (tenant_id, key, request_method, request_path, request_hash) DO UPDATE SET
            state = 'IN_PROGRESS',
            owner_token = EXCLUDED.owner_token,
            lease_expires_at = EXCLUDED.lease_expires_at,
            expires_at = EXCLUDED.expires_at,
            status_code = NULL,
            response_body = NULL,
            created_at = now()
          WHERE idempotency_key.expires_at <= now()
             OR (idempotency_key.state = 'IN_PROGRESS' AND idempotency_key.lease_expires_at <= now())
          RETURNING owner_token::text`;

        // Opportunistic and bounded: the replay window used to be a Redis TTL, and a table has none.
        // `SKIP LOCKED` so two claims never wait on — or deadlock over — each other's sweep.
        await tx.$executeRaw`
          DELETE FROM idempotency_key WHERE id IN (
            SELECT id FROM idempotency_key
             WHERE expires_at <= now()
             ORDER BY expires_at
             LIMIT ${SWEEP_BATCH}::int
             FOR UPDATE SKIP LOCKED
          )`;

        if (won[0]?.owner_token === token) {
          return { kind: 'OWNER', token } as const;
        }
        const existing = await tx.$queryRaw<
          { state: string; status_code: number | null; response_body: unknown }[]
        >`
          SELECT state, status_code, response_body
            FROM idempotency_key
           WHERE tenant_id = ${request.tenantId}::uuid
             AND key = ${request.key}
             AND request_method = ${request.method}
             AND request_path = ${request.path}
             AND request_hash = ${request.bodyHash}`;
        const row = existing[0];
        if (row === undefined) {
          return null;
        }
        if (row.state === 'COMPLETED' && row.status_code !== null) {
          return { kind: 'REPLAY', statusCode: row.status_code, body: row.response_body } as const;
        }
        return { kind: 'IN_PROGRESS' } as const;
      });
      if (outcome !== null) {
        return outcome;
      }
    }
    return { kind: 'IN_PROGRESS' };
  }

  async complete(
    request: IdempotentRequest,
    token: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    // `undefined` — a 204 — is stored as SQL NULL and replayed as nothing.
    const json = body === undefined ? null : JSON.stringify(body);
    await this.databases.withTenant(request.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE idempotency_key
           SET state = 'COMPLETED',
               status_code = ${statusCode}::int,
               response_body = ${json}::jsonb,
               owner_token = NULL,
               lease_expires_at = NULL
         WHERE tenant_id = ${request.tenantId}::uuid
           AND key = ${request.key}
           AND request_method = ${request.method}
           AND request_path = ${request.path}
           AND request_hash = ${request.bodyHash}
           AND state = 'IN_PROGRESS'
           AND owner_token = ${token}::uuid`;
    });
  }

  async release(request: IdempotentRequest, token: string): Promise<void> {
    await this.databases.withTenant(request.tenantId, async (tx) => {
      await tx.$executeRaw`
        DELETE FROM idempotency_key
         WHERE tenant_id = ${request.tenantId}::uuid
           AND key = ${request.key}
           AND request_method = ${request.method}
           AND request_path = ${request.path}
           AND request_hash = ${request.bodyHash}
           AND state = 'IN_PROGRESS'
           AND owner_token = ${token}::uuid`;
    });
  }
}
