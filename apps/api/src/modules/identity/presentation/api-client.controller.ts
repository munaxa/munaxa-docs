import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import {
  type ApiClient as WireApiClient,
  type Collection,
  type CreateApiClientBody,
  type MintedApiClient as WireMintedApiClient,
  apiClientListQuerySchema,
  createApiClientSchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import {
  API_CLIENT_SERVICE,
  type ApiClientRecord,
  type ApiClientService,
} from '../application/api-client.ports';

/**
 * Machine credentials, behind `integration:manage`.
 *
 * Four routes and deliberately no fifth. There is **no update**: a key's scopes and its subject
 * are what its holder was told they had, and changing either silently changes what a running
 * integration can do — the failure surfaces as somebody's nightly job starting to `403` with
 * nothing in their own logs to explain it. Revoke and mint is one more step for an administrator
 * and is a fact both sides can see.
 *
 * `DELETE` revokes rather than deleting, and answers the row rather than `204`. A revoked key must
 * stay in the list: "which keys existed, for whom, and when were they withdrawn" is what an access
 * review reads, and a row that vanished would take the answer with it.
 */
@Controller({ path: 'admin/api-clients', version: '1' })
@RequirePermission(Permission.INTEGRATION_MANAGE)
export class ApiClientController {
  constructor(@Inject(API_CLIENT_SERVICE) private readonly clients: ApiClientService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(apiClientListQuerySchema))
    query: ReturnType<typeof apiClientListQuerySchema.parse>,
  ): Promise<Collection<WireApiClient>> {
    const page = await this.clients.list(query);
    return {
      data: page.data.map(toWire),
      meta: page.meta,
    };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WireApiClient> {
    return toWire(await this.clients.get(id));
  }

  /**
   * Mints a key, and returns its secret **once**.
   *
   * `201` with the secret in the body is the only place it exists outside the caller's hands. It
   * is not stored in clear, not recoverable, and not in the audit payload — the trail records that
   * a key was created, for which subject and with which scopes, which is everything an
   * investigation needs and none of what would let it sign in as one.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createApiClientSchema)) body: CreateApiClientBody,
  ): Promise<WireMintedApiClient> {
    const minted = await this.clients.create(body);
    return { client: toWire(minted.client), secret: minted.secret };
  }

  @Delete(':id')
  async revoke(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<WireApiClient> {
    return toWire(await this.clients.revoke(id, version));
  }
}

function toWire(record: ApiClientRecord): WireApiClient {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    keyPrefix: record.keyPrefix,
    subjectUserId: record.subjectUserId,
    // Resolved by the screen from the users it already has. Left null here rather than joining,
    // because a list of keys is not a place to be re-deriving a directory.
    subjectDisplayName: null,
    scopes: [...record.scopes],
    expiresAt: record.expiresAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy,
    updatedAt: record.updatedAt.toISOString(),
    updatedBy: record.updatedBy,
    deletedAt: record.deletedAt?.toISOString() ?? null,
    deletedBy: record.deletedBy,
    version: record.version,
  };
}
