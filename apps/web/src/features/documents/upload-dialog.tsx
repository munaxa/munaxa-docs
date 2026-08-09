'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { Alert, Badge, Button, Dropzone, Progress, formatFileSize } from '@munaxa/ui';

import { SUPPORTED_EXTENSIONS } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import {
  type Choice,
  FormDialog,
  FormSection,
  PickerField,
  SelectField,
  TextAreaField,
  optionalText,
  text,
} from '../admin-shared';
import { createDocument } from './actions';
import { MetadataFields, type MetadataFieldDefinition, readMetadata } from './metadata-fields';
import { type StoredFile, type UploadProgress, localRejectionFor, uploadFile } from './upload';

/**
 * Adding documents to a folder.
 *
 * Multi-file by design, because that is how documents arrive: somebody drags in the fifteen
 * drawings for a revision, not one. Each file becomes its own document with its own outcome — so a
 * refused file does not take the other fourteen with it, and the person can see which one it was.
 *
 * **Transfers start on drop, not on submit.** Filling in the form takes longer than the upload for
 * anything but the largest files, so by the time somebody has chosen a type the bytes are already
 * in storage — and the duplicate warning has already arrived, which is the point of asking early.
 *
 * **Scanning is this same pipeline with a different source.** A scanner produces image files; the
 * intake flow narrows the accepted formats to what a scanner emits and marks the resulting
 * documents `SCAN`, so their provenance survives. There is no device driver here and none is
 * claimed — the phase report says exactly what that does and does not cover.
 *
 * The form is filled in **once** and applied to the whole batch, which is right for how batches
 * arrive: one set of drawings, one project, one review date. Each document still takes its title
 * from its own filename, which is the field that genuinely differs per file.
 */
export interface DocumentTypeChoice extends Choice {
  readonly fields: readonly MetadataFieldDefinition[];
}

interface FileState {
  readonly key: string;
  readonly file: File;
  readonly progress: UploadProgress;
  readonly stored: StoredFile | null;
  readonly problem: string | null;
  /** Set once the person has seen the duplicate warning and chosen to file anyway. */
  readonly acknowledged: boolean;
}

export function UploadDialog({
  open,
  onClose,
  onSaved,
  folderId,
  folderName,
  documentTypes,
  categories,
  confidentialityLevels,
  users,
  departments,
  origin,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly folderId: string;
  readonly folderName: string;
  readonly documentTypes: readonly DocumentTypeChoice[];
  readonly categories: readonly Choice[];
  readonly confidentialityLevels: readonly Choice[];
  readonly users: readonly Choice[];
  readonly departments: readonly Choice[];
  readonly origin: 'UPLOAD' | 'SCAN';
}): ReactNode {
  const translate = useTranslate();
  const [files, setFiles] = useState<readonly FileState[]>([]);
  const [documentTypeId, setDocumentTypeId] = useState(documentTypes[0]?.value ?? '');

  useEffect(() => {
    if (!open) {
      setFiles([]);
    }
  }, [open]);

  const selectedType = useMemo(
    () => documentTypes.find((type) => type.value === documentTypeId),
    [documentTypeId, documentTypes],
  );

  const update = useCallback((key: string, patch: Partial<FileState>): void => {
    setFiles((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }, []);

  const accept = useCallback(
    (dropped: File[]): void => {
      const added: FileState[] = dropped.map((file) => {
        const rejection = localRejectionFor(file);
        return {
          // Name, size and modification time together: dropping the same file twice is a mistake
          // worth ignoring, and two genuinely different files rarely agree on all three.
          key: `${file.name}:${String(file.size)}:${String(file.lastModified)}`,
          file,
          progress: { phase: rejection === null ? 'reading' : 'failed', fraction: 0 },
          stored: null,
          problem: rejection === null ? null : translate(`documents.upload.rejected.${rejection}`),
          acknowledged: false,
        };
      });

      setFiles((current) => [
        ...current,
        ...added.filter((entry) => !current.some((existing) => existing.key === entry.key)),
      ]);

      for (const entry of added) {
        if (entry.problem !== null) {
          continue;
        }
        void uploadFile(entry.file, (progress) => {
          update(entry.key, { progress });
        }).then((result) => {
          update(
            entry.key,
            'reason' in result
              ? { problem: result.reason, progress: { phase: 'failed', fraction: 0 } }
              : { stored: result },
          );
        });
      }
    },
    [translate, update],
  );

  const ready = files.filter((entry) => entry.stored !== null);
  const blocked = ready.filter(
    (entry) => (entry.stored?.duplicates.length ?? 0) > 0 && !entry.acknowledged,
  );
  const unscanned = ready.filter((entry) => entry.stored?.scanStatus !== 'CLEAN');

  /**
   * Files every stored upload as a document.
   *
   * Sequential rather than concurrent: each create writes an audit event and moves the same blob's
   * reference count, and fifteen transactions contending on one row buys nothing — the bytes are
   * already stored, so this is a series of small writes.
   *
   * The first failure stops the batch and reports it. Continuing would leave somebody with nine
   * documents filed, six not, and one sentence explaining none of it.
   */
  const submit = useCallback(
    async (data: FormData): Promise<ActionResult<unknown>> => {
      const metadata = selectedType === undefined ? {} : readMetadata(data, selectedType.fields);
      const shared = {
        folderId,
        documentTypeId: text(data, 'documentTypeId'),
        categoryId: optionalText(data, 'categoryId') ?? null,
        ...(optionalText(data, 'confidentialityId') !== undefined && {
          confidentialityId: text(data, 'confidentialityId'),
        }),
        ...(optionalText(data, 'description') !== undefined && {
          description: text(data, 'description'),
        }),
        metadata,
        origin,
      };

      let last: ActionResult<unknown> = { ok: true, value: undefined };
      for (const entry of ready) {
        if (entry.stored === null) {
          continue;
        }
        last = await createDocument({
          ...shared,
          // The filename without its extension: it is what the person named the thing, and asking
          // them to retype it for fifteen drawings is how fifteen documents end up called the same.
          title: entry.file.name.replace(/\.[^.]+$/, ''),
          fileObjectId: entry.stored.fileObjectId,
          filename: entry.file.name,
          acknowledgeDuplicate: entry.acknowledged || entry.stored.duplicates.length === 0,
        });
        if (!last.ok) {
          return last;
        }
      }
      return last;
    },
    [folderId, origin, ready, selectedType],
  );

  if (!open) {
    return null;
  }

  return (
    <FormDialog
      open
      title={translate(origin === 'SCAN' ? 'documents.upload.scanTitle' : 'documents.upload.title')}
      description={translate('documents.upload.into', { folder: folderName })}
      onClose={onClose}
      onSubmit={submit}
      onSaved={onSaved}
      submitLabel={translate('documents.upload.fileCount', { count: String(ready.length) })}
    >
      <FormSection
        first
        title={translate('documents.upload.sectionFiles')}
        description={translate('documents.upload.sectionFilesHint')}
      >
        <Dropzone
          multiple
          accept={origin === 'SCAN' ? SCANNER_FORMATS : SUPPORTED_EXTENSIONS.join(',')}
          onFiles={accept}
          labels={{
            prompt: translate(
              origin === 'SCAN' ? 'documents.upload.scanPrompt' : 'documents.upload.prompt',
            ),
            browse: translate('documents.upload.browse'),
            hint: translate('documents.upload.hint'),
          }}
        />

        {files.length > 0 && (
          <ul className="flex flex-col gap-3">
            {files.map((entry) => (
              <li key={entry.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate">{entry.file.name}</span>
                  <span className="text-sm opacity-70">{formatFileSize(entry.file.size)}</span>
                  <PhaseBadge entry={entry} />
                </div>
                {entry.progress.phase === 'transferring' && (
                  <Progress
                    value={Math.round(entry.progress.fraction * 100)}
                    label={translate('documents.upload.phase.transferring')}
                  />
                )}
                {entry.problem !== null && <Alert tone="danger">{entry.problem}</Alert>}
                {entry.stored !== null && entry.stored.duplicates.length > 0 && (
                  <DuplicateWarning
                    matches={entry.stored.duplicates}
                    acknowledged={entry.acknowledged}
                    onAcknowledge={() => {
                      update(entry.key, { acknowledged: true });
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {unscanned.length > 0 && (
          // Stored, and not attachable. Saying so here is the difference between a refusal somebody
          // understands and one that looks arbitrary two clicks later.
          <Alert tone="warning">{translate('documents.upload.unscanned')}</Alert>
        )}
        {blocked.length > 0 && (
          <Alert tone="warning">{translate('documents.upload.blockedByDuplicates')}</Alert>
        )}
      </FormSection>

      <FormSection
        title={translate('documents.upload.sectionClassification')}
        description={translate('documents.upload.sectionClassificationHint')}
      >
        <SelectField
          name="documentTypeId"
          label={translate('documents.field.documentType')}
          required
          value={documentTypeId}
          onValueChange={(value) => {
            // The type decides which fields exist, so values entered against the previous one are not
            // values on this one. Re-rendering the field set from the new type is what clears them.
            setDocumentTypeId(value);
          }}
          choices={documentTypes}
        />
        <PickerField
          name="categoryId"
          label={translate('documents.field.category')}
          options={categories}
          clearable
        />
        <PickerField
          name="confidentialityId"
          label={translate('documents.field.confidentiality')}
          hint={translate('documents.field.confidentialityHint')}
          options={confidentialityLevels}
          clearable
        />
      </FormSection>

      <FormSection title={translate('documents.upload.sectionDetails')}>
        <TextAreaField name="description" label={translate('documents.field.description')} />

        {selectedType !== undefined && (
          <MetadataFields
            key={selectedType.value}
            fields={selectedType.fields}
            userChoices={users}
            departmentChoices={departments}
          />
        )}
      </FormSection>
    </FormDialog>
  );
}

/** What a scanner emits. Narrower than the library accepts, because a scan is images or a PDF. */
const SCANNER_FORMATS = '.png,.jpg,.jpeg,.tif,.tiff,.pdf';

function PhaseBadge({ entry }: { readonly entry: FileState }): ReactNode {
  const translate = useTranslate();
  if (entry.problem !== null) {
    return <Badge tone="danger">{translate('documents.upload.phase.failed')}</Badge>;
  }
  if (entry.stored !== null) {
    return (
      <Badge tone={entry.stored.deduplicated ? 'muted' : 'success'}>
        {translate(
          entry.stored.deduplicated
            ? 'documents.upload.phase.alreadyStored'
            : 'documents.upload.phase.stored',
        )}
      </Badge>
    );
  }
  return <Badge>{translate(`documents.upload.phase.${entry.progress.phase}`)}</Badge>;
}

/**
 * What this file already is, elsewhere.
 *
 * Named rather than counted: "there are 3 duplicates" is not something anybody can act on, and
 * "this is already QA-014 under Quality/Procedures" is. Filing anyway is one click, because a
 * duplicate is frequently legitimate — the same signed form against two projects — and what makes
 * it a mistake is doing it without knowing.
 */
function DuplicateWarning({
  matches,
  acknowledged,
  onAcknowledge,
}: {
  readonly matches: readonly {
    documentId: string;
    title: string;
    documentNumber: string | null;
    folderName: string;
  }[];
  readonly acknowledged: boolean;
  readonly onAcknowledge: () => void;
}): ReactNode {
  const translate = useTranslate();
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-2">
        <span>
          {translate('documents.upload.duplicateWarning', { count: String(matches.length) })}
        </span>
        <ul className="text-sm">
          {matches.map((match) => (
            <li key={match.documentId}>
              {match.documentNumber === null
                ? match.title
                : `${match.documentNumber} — ${match.title}`}
              {` · ${match.folderName}`}
            </li>
          ))}
        </ul>
        {!acknowledged && (
          <Button type="button" variant="outline" size="sm" onClick={onAcknowledge}>
            {translate('documents.upload.fileAnyway')}
          </Button>
        )}
      </div>
    </Alert>
  );
}
