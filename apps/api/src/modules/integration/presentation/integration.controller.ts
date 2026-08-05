import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  type AuditSink as WireAuditSink,
  type AuditStreamPage,
  type Collection,
  type CreateWebhookEndpointBody,
  type CreatedWebhookEndpoint,
  type UpdateWebhookEndpointBody,
  type UpsertAuditSinkBody,
  type WebhookDelivery as WireWebhookDelivery,
  type WebhookEndpoint as WireWebhookEndpoint,
  auditStreamQuerySchema,
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
  upsertAuditSinkSchema,
  webhookDeliveryListQuerySchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { AuditSinkService } from '../application/audit-sink.service';
import { WebhookAdminService } from '../application/webhook-admin.service';
import type {
  AuditSinkRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from '../application/ports';

/**
 * Outbound webhooks, behind `integration:manage`.
 *
 * The delivery log is a read on the endpoint rather than a resource of its own, because a delivery
 * has no meaning apart from the endpoint it was for — and because "why is my integration not
 * receiving anything" is a question asked *about an endpoint*, so the log has to be one click from
 * the row that is failing.
 */
@Controller({ path: 'admin/webhooks', version: '1' })
@RequirePermission(Permission.INTEGRATION_MANAGE)
export class WebhookController {
  constructor(private readonly webhooks: WebhookAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(webhookDeliveryListQuerySchema))
    query: ReturnType<typeof webhookDeliveryListQuerySchema.parse>,
  ): Promise<Collection<WireWebhookEndpoint>> {
    const page = await this.webhooks.list(query);
    return {
      data: page.data.map(toWireEndpoint),
      meta: page.meta,
    };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WireWebhookEndpoint> {
    return toWireEndpoint(await this.webhooks.get(id));
  }

  /** `201` with the signing secret. The only response that carries it, ever. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createWebhookEndpointSchema)) body: CreateWebhookEndpointBody,
  ): Promise<CreatedWebhookEndpoint> {
    const created = await this.webhooks.create(body);
    return { endpoint: toWireEndpoint(created.endpoint), secret: created.secret };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWebhookEndpointSchema)) body: UpdateWebhookEndpointBody,
    @IfMatch() version: number | undefined,
  ): Promise<WireWebhookEndpoint> {
    return toWireEndpoint(await this.webhooks.update(id, version, body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.webhooks.remove(id);
  }

  /**
   * What this endpoint has been sent, and what became of it.
   *
   * The **payload is deliberately absent** from every row. It is stored — that is what makes a
   * dead delivery replayable — and it names the object an event was about, so a delivery log that
   * rendered it would be a list of every document identifier that changed, shown on a screen whose
   * permission is `integration:manage` rather than `document:view`. The row says what happened to
   * the delivery; the ordinary API says what happened to the document.
   */
  @Get(':id/deliveries')
  async deliveries(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(webhookDeliveryListQuerySchema))
    query: ReturnType<typeof webhookDeliveryListQuerySchema.parse>,
  ): Promise<Collection<WireWebhookDelivery>> {
    const page = await this.webhooks.listDeliveries(id, query.state ?? null, query);
    return {
      data: page.data.map(toWireDelivery),
      meta: page.meta,
    };
  }
}

/**
 * The audit sink and its stream — 13 §6.
 *
 * Two permissions on one controller, which is the arrangement `RoutePermissionRegistry` reads at
 * the *method* when a method declares its own: configuring the sink is `integration:manage`, and
 * **reading the stream is `audit:export`**. That split is the point rather than an accident. An
 * administrator who may point the trail at a collector is not thereby somebody who may read the
 * trail, and a collector polling the cursor is not somebody who may reconfigure where it goes.
 * 08 §6 grants `audit:export` to the auditor and the tenant administrator; a machine token
 * reaching this holds the `audit:read` scope, whose only two admitted permissions are
 * `audit:view` and `audit:export`.
 */
@Controller({ path: 'admin/audit-sink', version: '1' })
export class AuditSinkController {
  constructor(private readonly sinks: AuditSinkService) {}

  @Get()
  @RequirePermission(Permission.INTEGRATION_MANAGE)
  async get(): Promise<WireAuditSink | null> {
    const sink = await this.sinks.get();
    return sink ? toWireSink(sink) : null;
  }

  @Put()
  @RequirePermission(Permission.INTEGRATION_MANAGE)
  async upsert(
    @Body(new ZodValidationPipe(upsertAuditSinkSchema)) body: UpsertAuditSinkBody,
  ): Promise<WireAuditSink> {
    return toWireSink(await this.sinks.upsert(body));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.INTEGRATION_MANAGE)
  async remove(): Promise<void> {
    await this.sinks.remove();
  }
}

/**
 * The pull cursor — a collector's own endpoint, and its own controller.
 *
 * Separate from the one above because it carries a different permission, and 15 §5's boot-time
 * assertion is cleanest when a controller has one. It is also the honest grouping: this is a
 * *read of the trail*, so it sits beside `/audit` conceptually even though it is served here,
 * where the cursor and the action filter live.
 */
@Controller({ path: 'audit/stream', version: '1' })
@RequirePermission(Permission.AUDIT_EXPORT)
export class AuditStreamController {
  constructor(private readonly sinks: AuditSinkService) {}

  @Get()
  async page(
    @Query(new ZodValidationPipe(auditStreamQuerySchema))
    query: ReturnType<typeof auditStreamQuerySchema.parse>,
  ): Promise<AuditStreamPage> {
    const page = await this.sinks.page(BigInt(query.afterSequence), query.limit);
    return {
      events: page.events,
      // A string, because `sequence` is a `BIGINT` and exceeds `Number.MAX_SAFE_INTEGER` at scale.
      // A cursor that silently lost precision would skip events and report itself gap-free.
      cursor: page.cursor.toString(),
      hasMore: page.hasMore,
    };
  }
}

function toWireEndpoint(record: WebhookEndpointRecord): WireWebhookEndpoint {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    eventTypes: [...record.eventTypes],
    enabled: record.enabled,
    failureCount: record.failureCount,
    disabledAt: record.disabledAt?.toISOString() ?? null,
    disabledReason: record.disabledReason,
    lastSuccessAt: record.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: record.lastFailureAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy,
    updatedAt: record.updatedAt.toISOString(),
    updatedBy: record.updatedBy,
    deletedAt: record.deletedAt?.toISOString() ?? null,
    deletedBy: record.deletedBy,
    version: record.version,
    // `secret` is absent from the wire type, so there is no field a mapper could forget to drop.
  };
}

function toWireDelivery(record: WebhookDeliveryRecord): WireWebhookDelivery {
  return {
    id: record.id,
    endpointId: record.endpointId,
    eventId: record.eventId,
    eventType: record.eventType,
    state: record.state,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: record.deliveredAt?.toISOString() ?? null,
    responseStatus: record.responseStatus,
    lastError: record.lastError,
    createdAt: record.createdAt.toISOString(),
  };
}

function toWireSink(record: AuditSinkRecord): WireAuditSink {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    endpointUrl: record.endpointUrl,
    actions: [...record.actions],
    lastStreamedSequence: record.lastStreamedSequence.toString(),
    lastStreamedAt: record.lastStreamedAt?.toISOString() ?? null,
    lastError: record.lastError,
    enabled: record.enabled,
    version: record.version,
  };
}
