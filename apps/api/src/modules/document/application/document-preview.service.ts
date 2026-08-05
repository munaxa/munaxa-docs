import { Inject, Injectable } from '@nestjs/common';

import {
  ActorChannel,
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  type DocumentId,
  type RevisionId,
  Settings,
  type UserId,
  asId,
} from '@edms/domain';
import type { PreviewContent, PreviewManifest, PreviewText } from '@edms/contracts';

import { READ_AUDIT_BUFFER, type ReadAuditBuffer } from '../../../core/audit/read-audit.port';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { ForbiddenError, NotFoundError } from '../../../core/errors/application-errors';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { USER_DIRECTORY, type UserDirectory } from '../../identity/application/ports';
import { PreviewQueryService } from '../../preview/application/preview-query.service';
import { DocumentAudit } from '../domain/audit-actions';
import type { ConfidentialityView } from './configuration.port';
import { DOCUMENT_CONFIGURATION, type DocumentConfiguration } from './configuration.port';
import {
  DOCUMENT_REPOSITORY,
  type DocumentRepository,
  type DocumentRow,
  REVISION_WRITER,
  type RevisionWriter,
} from './ports';

/**
 * The preview access decisions — 14 §4's sequence, owned where those words mean something.
 *
 * **Permission** is the route's (`document:view`; drafts additionally `document:history:view`;
 * print additionally `document:print`). **State** is decided here: a reader is served the
 * *current* (published) revision, exactly as downloads are, and a revision-addressed request is
 * refused unless the revision belongs to the document. **Confidentiality** is applied last and
 * only ever subtracts: `allow_print` finally means something, and `watermark` decides whether
 * the issued URL points at bytes that will carry the stamp.
 *
 * Preview deliberately does **not** require `document:download`, and a level's
 * `allow_download = false` does not block it — "readable, not downloadable" is the whole point
 * of the preview path (14 §1). What leaves through it is a rendition, watermarked where the
 * level demands, never the original file.
 *
 * Issuance is audited: a view through the existing `DOCUMENT_VIEWED` action — gated by
 * `audit.readEventsAboveRank`, its first consumer, and since Phase 9 written through 13 §5's
 * buffer rather than inline — and a print through 13 §2's `PRINTED` row, synchronously and
 * unconditionally, because 13 says prints always are. The `open()` use case keeps writing
 * `VIEWED` for the record being opened; this writes it for content actually served, which is
 * the fact a confidentiality level's "audit on read" is about.
 */
@Injectable()
export class DocumentPreviewService {
  constructor(
    private readonly writer: AdministeredWriter,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(REVISION_WRITER) private readonly revisions: RevisionWriter,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(READ_AUDIT_BUFFER) private readonly readAudit: ReadAuditBuffer,
    private readonly preview: PreviewQueryService,
  ) {}

  /** The viewer's manifest for the effective revision. */
  async manifest(documentId: string): Promise<PreviewManifest> {
    return this.writer.read(async () => {
      const { revision, level } = await this.effective(documentId);
      return this.buildManifest(revision.id, level);
    });
  }

  /** The manifest for one named revision — history, behind `document:history:view`. */
  async revisionManifest(documentId: string, revisionId: string): Promise<PreviewManifest> {
    return this.writer.read(async () => {
      const { revision, level } = await this.named(documentId, revisionId);
      return this.buildManifest(revision.id, level);
    });
  }

  /** A short-lived URL onto the viewing artefact, audited as a view of the content. */
  async viewContent(documentId: string, revisionId?: string): Promise<PreviewContent> {
    const resolved = await this.writer.read(async () =>
      revisionId === undefined ? this.effective(documentId) : this.named(documentId, revisionId),
    );
    return this.issue(documentId, resolved.revision.id, resolved.level, 'view');
  }

  /**
   * A print, through the preview path and never the original (14 §4): the same rendition the
   * viewer draws, watermarked when the level demands, audited as 13 §2's `PRINTED`.
   */
  async printContent(documentId: string): Promise<PreviewContent> {
    const resolved = await this.writer.read(() => this.effective(documentId));
    if (!resolved.level.allowPrint) {
      // The level subtracts and never grants: holding `document:print` is not enough if the
      // classification forbids it — the same construction as downloads.
      throw new ForbiddenError('print this document');
    }
    return this.issue(documentId, resolved.revision.id, resolved.level, 'print');
  }

  /** The extracted text — the viewer's text pane and its in-document search. */
  async text(documentId: string, revisionId?: string): Promise<PreviewText | null> {
    const resolved = await this.writer.read(async () =>
      revisionId === undefined ? this.effective(documentId) : this.named(documentId, revisionId),
    );
    const pages = await this.preview.textPages(resolved.revision.id);
    return pages === null
      ? null
      : { source: pages.source, lowConfidence: pages.lowConfidence, pages: [...pages.pages] };
  }

  private async buildManifest(
    revisionId: RevisionId,
    level: ConfidentialityView,
  ): Promise<PreviewManifest> {
    const facts = await this.preview.facts(revisionId);
    return {
      revisionId,
      state: facts.state === 'READY' && facts.mode === null ? 'UNSUPPORTED' : facts.state,
      reason: facts.reason,
      pageCount: facts.pageCount,
      mode: facts.mode,
      hasText: facts.hasText,
      ocr: facts.ocr,
      confidentiality: {
        downloadAllowed: level.allowDownload,
        printAllowed: level.allowPrint,
        watermark: level.watermark,
      },
    };
  }

  private async issue(
    documentId: string,
    revisionId: RevisionId,
    level: ConfidentialityView,
    purpose: 'view' | 'print',
  ): Promise<PreviewContent> {
    const build = async (): Promise<PreviewContent> => {
      const facts = await this.preview.facts(revisionId);
      const target = facts.state === 'READY' ? await this.preview.viewTarget(revisionId) : null;

      if (facts.state !== 'READY') {
        return notReady(facts.state, facts.reason);
      }
      if (target === null) {
        // Text-only renders (a Word document with no converter, plain text) have no artefact to
        // stream; the viewer's text pane is the presentation, and printing it prints the pane.
        return {
          state: 'READY',
          reason: null,
          url: null,
          expiresAt: null,
          contentType: null,
          mode: null,
        };
      }
      if (level.watermark && target.mode !== 'PDF') {
        // A mark must live inside the bytes, and only the PDF rendition can carry one. An image
        // format with no rendition is honestly not previewable at this level.
        return notReady(
          'UNSUPPORTED',
          'This confidentiality level requires a watermark, and this format has no rendition to stamp.',
        );
      }
      const issued = this.preview.issueStreamUrl(target, {
        disposition: 'inline',
        watermark: level.watermark ? await this.watermarkFor(documentId) : null,
      });
      return {
        state: 'READY',
        reason: null,
        url: issued.url,
        expiresAt: issued.expiresAt.toISOString(),
        contentType: target.mimeType,
        mode: target.mode,
      };
    };

    // A print is always audited (13 §2 — prints unconditionally); a view is audited at or above
    // the tenant's `audit.readEventsAboveRank` — the setting's first consumer. Below the rank,
    // the issuance happens in a plain read: serving a preview of an unclassified notice must
    // not cost a hash-chained row per page turn.
    const audited =
      purpose === 'print' ||
      level.rank >= (await this.settings.get(Settings.AUDIT_READS_ABOVE_CONFIDENTIALITY_RANK));
    if (!audited) {
      return this.writer.read(build);
    }

    // A print is a synchronous, transactional write; a view goes to the buffer. That is not an
    // inconsistency but 13 §5's own split: `VIEWED` is the one event the specification exempts
    // from synchronous writing because "it must not cost a transaction per page view", and a
    // print is rare, deliberate, and the thing a confidentiality level most wants a hard record
    // of. Phase 9 makes the exemption real; until then every page turn took the tenant's audit
    // advisory lock.
    if (purpose === 'print') {
      return this.writer.write<PreviewContent>(async () => {
        const content = await build();
        return {
          result: content,
          change: {
            action: DocumentAudit.DOCUMENT_PRINTED,
            subjectType: AuditSubjectType.DOCUMENT,
            subjectId: asId<AnyId>(documentId),
            operation: AdministrativeOperation.UPDATED,
            after: {
              preview: true,
              revisionId,
              served: content.url !== null,
              watermark: level.watermark,
            },
          },
        };
      });
    }

    const content = await this.writer.read(build);
    const context = requireContext();
    await this.readAudit.record(
      {
        tenantId: context.tenantId,
        userId: context.userId,
        channel: context.channel ?? ActorChannel.WEB,
        ...(context.apiClientId !== undefined && { apiClientId: context.apiClientId }),
        correlationId: context.correlationId,
        ipAddress: null,
        userAgent: null,
      },
      {
        action: DocumentAudit.DOCUMENT_VIEWED,
        subjectType: AuditSubjectType.DOCUMENT,
        subjectId: asId<AnyId>(documentId),
        outcome: AuditOutcome.SUCCESS,
        payload: {
          operation: AdministrativeOperation.UPDATED,
          after: {
            preview: true,
            revisionId,
            served: content.url !== null,
            watermark: level.watermark,
          },
        },
      },
    );
    return content;
  }

  /** 14 §4's parameters: who is looking, at which controlled document. */
  private async watermarkFor(
    documentId: string,
  ): Promise<{ viewer: string; viewerFallback: string; reference: string }> {
    const document = await this.documents.findById(asId<DocumentId>(documentId), false);
    const userId = requireContext().userId;
    const contact = userId === null ? null : await this.users.contactFor(asId<UserId>(userId));
    return {
      // The preview layer picks whichever of the two its stamp can actually encode.
      viewer: contact?.displayName ?? 'system',
      viewerFallback: contact?.email ?? 'system',
      reference: document?.documentNumber ?? document?.title ?? documentId,
    };
  }

  private async effective(documentId: string) {
    const document = await this.require(documentId);
    const revision = document.currentRevision ?? document.latestRevision;
    if (revision === null) {
      throw new NotFoundError('The requested file');
    }
    return { revision: { id: asId<RevisionId>(revision.id) }, level: await this.level(document) };
  }

  private async named(documentId: string, revisionId: string) {
    const document = await this.require(documentId);
    const facts = await this.revisions.describe(documentId, revisionId);
    if (facts === null) {
      // Cross-document addressing gets the same answer as nonexistence, deliberately.
      throw new NotFoundError('The requested revision');
    }
    return { revision: { id: asId<RevisionId>(facts.id) }, level: await this.level(document) };
  }

  private async level(document: DocumentRow): Promise<ConfidentialityView> {
    const level = await this.configuration.confidentiality(document.confidentialityId);
    if (level !== null) {
      return level;
    }
    // A document whose level was deleted keeps the safest reading: nothing subtracted from
    // viewing, nothing granted for print or download.
    return {
      id: document.confidentialityId,
      name: document.confidentialityName,
      rank: document.confidentialityRank,
      allowDownload: false,
      allowPrint: false,
      watermark: true,
      requireReason: false,
    };
  }

  private async require(id: string): Promise<DocumentRow> {
    const document = await this.documents.findById(asId<AnyId>(id) as never, false);
    if (document === null) {
      throw new NotFoundError('The requested document');
    }
    return document;
  }
}

function notReady(state: PreviewContent['state'], reason: string | null): PreviewContent {
  return { state, reason, url: null, expiresAt: null, contentType: null, mode: null };
}
