'use client';

import { type ReactNode, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Panel,
  Section,
  Select,
  Switch,
  useToast,
} from '@munaxa/ui';
import { useRouter } from 'next/navigation';

import type { Setting, SettingsResponse } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import { AdminScreen } from '../admin-shared';
import { resetSetting, updateSetting } from './actions';

const GROUP_LABELS: Readonly<Record<string, MessageKey>> = {
  locale: 'admin.settings.groupLocale',
  security: 'admin.settings.groupSecurity',
  audit: 'admin.settings.groupAudit',
};

/**
 * Tenant settings.
 *
 * Not a list, and deliberately not built on `ResourceList`: a setting is not a record. There is nothing
 * to create, nothing to delete, no recycle bin, and the whole catalogue fits on one screen. What it
 * needs instead is per-setting saving, because each key is written on its own — the API merges in the
 * database, so two administrators changing different settings at the same time cannot drop each
 * other's change.
 *
 * The control for each setting comes from its declared `kind`, which the API sends. That is why this
 * screen has no per-key mapping to fall out of step with the catalogue: adding a setting to
 * `@edms/domain` makes it appear here, with bounds and choices the catalogue owns.
 *
 * The diagnostics are shown rather than swallowed. A setting silently falling back to its default is a
 * tenant running on a configuration they did not choose, and the only way anyone finds out is if
 * somebody says so.
 */
export function SettingsScreen({ settings }: { settings: SettingsResponse }): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  const groups = new Map<string, Setting[]>();
  for (const setting of settings.data) {
    const group = setting.key.split('.')[0] ?? 'other';
    const bucket = groups.get(group);
    if (bucket === undefined) {
      groups.set(group, [setting]);
    } else {
      bucket.push(setting);
    }
  }

  const run = (key: string, action: () => Promise<ActionResult<SettingsResponse>>): void => {
    setPending(key);
    void action().then((result) => {
      setPending(null);
      if (result.ok) {
        // Refreshed rather than patched from the response, so `isOverridden` and the diagnostics come
        // from the same read as everything else on the screen.
        router.refresh();
        return;
      }
      toast.error(result.detail ?? translate(`error.${result.code}`));
    });
  };

  return (
    <AdminScreen titleKey="admin.settings.title" descriptionKey="admin.settings.description">
      {settings.diagnostics.fellBack.length === 0 ? null : (
        <Alert tone="warning" live="status">
          {translate('admin.settings.fellBack', {
            keys: settings.diagnostics.fellBack.join(', '),
          })}
        </Alert>
      )}
      {settings.diagnostics.unrecognised.length === 0 ? null : (
        <Alert tone="info" live="status">
          {translate('admin.settings.unrecognised', {
            keys: settings.diagnostics.unrecognised.join(', '),
          })}
        </Alert>
      )}

      {[...groups.entries()].map(([group, items]) => (
        <Section key={group} title={translate(GROUP_LABELS[group] ?? 'admin.sections.system')}>
          <div className="flex flex-col gap-3">
            {items.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                busy={pending === setting.key}
                onSave={(value) => {
                  run(setting.key, () => updateSetting({ key: setting.key, value }));
                }}
                onReset={() => {
                  run(setting.key, () => resetSetting({ key: setting.key }));
                }}
              />
            ))}
          </div>
        </Section>
      ))}
    </AdminScreen>
  );
}

/**
 * One setting, with its own save button.
 *
 * The value is held locally while it is being edited and compared against what the server sent, so the
 * save button is only offered when there is something to save — and "using the default" is shown from
 * the server's `isOverridden` rather than by comparing values here. Equality is not identity for a
 * non-primitive value, and a client that guessed would be wrong for exactly the settings that matter.
 */
function SettingRow({
  setting,
  busy,
  onSave,
  onReset,
}: {
  setting: Setting;
  busy: boolean;
  onSave: (value: unknown) => void;
  onReset: () => void;
}): ReactNode {
  const translate = useTranslate();
  const [draft, setDraft] = useState<string>(asText(setting.value));
  const [enabled, setEnabled] = useState<boolean>(setting.value === true);

  const dirty =
    setting.kind === 'boolean'
      ? enabled !== (setting.value === true)
      : draft !== asText(setting.value);

  return (
    <Panel
      title={setting.key}
      actions={
        <span className="flex items-center gap-2">
          <Badge tone={setting.isOverridden ? 'warning' : 'muted'}>
            {translate(
              setting.isOverridden ? 'admin.settings.overridden' : 'admin.settings.usingDefault',
            )}
          </Badge>
          {setting.isOverridden ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReset}>
              {translate('admin.settings.reset')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={busy || !dirty}
            onClick={() => {
              onSave(setting.kind === 'boolean' ? enabled : coerce(setting, draft));
            }}
          >
            {busy ? translate('admin.actions.saving') : translate('admin.actions.save')}
          </Button>
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">{setting.description}</p>

        <Field label={translate('admin.settings.value')}>
          {setting.kind === 'boolean' ? (
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
          ) : setting.kind === 'choice' ? (
            <Select
              value={draft}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
              }}
            >
              {(setting.allowed ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={setting.kind === 'integer' ? 'number' : 'text'}
              value={draft}
              disabled={busy}
              // The bounds are the catalogue's, sent with the setting. Stating them here would be a
              // second copy of a rule the API enforces and the product owns.
              min={setting.minimum}
              max={setting.maximum}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <p className="text-muted-foreground text-xs">
          {translate('admin.settings.defaultValue')}: {asText(setting.defaultValue)}
        </p>
      </div>
    </Panel>
  );
}

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Turns the edited text back into the kind the setting declares.
 *
 * An integer that does not parse is sent as the text it was, so the API refuses it with the
 * catalogue's own message rather than this screen quietly substituting a zero.
 */
function coerce(setting: Setting, draft: string): unknown {
  if (setting.kind !== 'integer') {
    return draft;
  }
  const parsed = Number.parseInt(draft, 10);
  return Number.isFinite(parsed) ? parsed : draft;
}
