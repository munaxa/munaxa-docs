'use server';

import {
  type AuditSink,
  type CreatedWebhookEndpoint,
  type IdentityProvider,
  type MintedApiClient,
  type WebhookEndpoint,
  createApiClientSchema,
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
  upsertAuditSinkSchema,
  upsertIdentityProviderSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to the integration platform.
 *
 * Two of these are unlike an ordinary edit, and both for the same reason: **they return a secret
 * that will never be returned again**. Minting an API client and creating a webhook endpoint each
 * hand back a credential in the response body and nowhere else, so the screen has to show it once
 * and say so — a form that quietly discarded it would leave somebody with an integration they
 * cannot configure and no way back but to mint another.
 *
 * There is no `updateApiClient`, and its absence is deliberate rather than an omission: changing a
 * key's scopes or its subject silently changes what a running integration can do, and the failure
 * surfaces as somebody's nightly job starting to `403` with nothing in their own logs to explain
 * it. Revoke and mint is one more step and is a fact both sides can see.
 */

export async function createApiClient(input: unknown): Promise<ActionResult<MintedApiClient>> {
  return validated(createApiClientSchema, input, (body) =>
    adminWrite<MintedApiClient>({ path: '/admin/api-clients', method: 'POST', body }),
  );
}

/**
 * Revokes a key.
 *
 * `DELETE` revokes rather than deletes — a revoked key stays in the list, because "which keys
 * existed, for whom, and when were they withdrawn" is what an access review reads, and a row that
 * vanished would take the answer with it. The API answers the row for exactly that reason; the
 * screen refreshes its page rather than reading it, so nothing here needs the body.
 */
export async function revokeApiClient(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/api-clients/${id}`, method: 'DELETE', version });
}

export async function createWebhook(input: unknown): Promise<ActionResult<CreatedWebhookEndpoint>> {
  return validated(createWebhookEndpointSchema, input, (body) =>
    adminWrite<CreatedWebhookEndpoint>({ path: '/admin/webhooks', method: 'POST', body }),
  );
}

export async function updateWebhook(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<WebhookEndpoint>> {
  return validated(updateWebhookEndpointSchema, input, (body) =>
    adminWrite<WebhookEndpoint>({ path: `/admin/webhooks/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteWebhook(id: string): Promise<ActionResult<void>> {
  return adminWrite({ path: `/admin/webhooks/${id}`, method: 'DELETE' });
}

export async function upsertIdentityProvider(
  input: unknown,
): Promise<ActionResult<IdentityProvider>> {
  return validated(upsertIdentityProviderSchema, input, (body) =>
    adminWrite<IdentityProvider>({ path: '/admin/identity-provider', method: 'PUT', body }),
  );
}

export async function removeIdentityProvider(): Promise<ActionResult<void>> {
  return adminWrite({ path: '/admin/identity-provider', method: 'DELETE' });
}

export async function upsertAuditSink(input: unknown): Promise<ActionResult<AuditSink>> {
  return validated(upsertAuditSinkSchema, input, (body) =>
    adminWrite<AuditSink>({ path: '/admin/audit-sink', method: 'PUT', body }),
  );
}

export async function removeAuditSink(): Promise<ActionResult<void>> {
  return adminWrite({ path: '/admin/audit-sink', method: 'DELETE' });
}
