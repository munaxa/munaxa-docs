import { describe, expect, it } from 'vitest';

import { DigestFrequency, NotificationChannel } from '@edms/domain';

import {
  ALL_NOTIFICATION_TYPES,
  NotificationType,
  channelsFor,
  notificationTypeFor,
  shouldSendImmediately,
} from './notification-types';
import { DEFAULT_TEMPLATES, defaultTemplate } from './default-templates';
import { escapeHtml, render, renderMessage } from './template';

const AVAILABLE = [NotificationChannel.EMAIL, NotificationChannel.IN_APP];

describe('the notification catalogue', () => {
  it('declares every type exactly once and can look each one up', () => {
    const keys = ALL_NOTIFICATION_TYPES.map((type) => type.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(notificationTypeFor(key)?.key).toBe(key);
    }
    expect(notificationTypeFor('security.invented')).toBeNull();
  });

  it('ships a template for every type, in both languages', () => {
    for (const type of ALL_NOTIFICATION_TYPES) {
      for (const locale of ['en', 'ar']) {
        // Every type must be deliverable on at least one of its default channels, or it is a
        // notification that can never reach anybody.
        const rendered = type.defaultChannels.some(
          (channel) => defaultTemplate(type.key, locale, channel) !== null,
        );
        expect(rendered, `${type.key} / ${locale}`).toBe(true);
      }
    }
  });

  it('declares a variable list that its templates stay within', () => {
    for (const type of ALL_NOTIFICATION_TYPES) {
      const allowed = new Set(['displayName', ...type.variables]);
      for (const byChannel of Object.values(DEFAULT_TEMPLATES[type.key] ?? {})) {
        for (const template of Object.values(byChannel)) {
          const used =
            [template.subject, template.bodyText, template.bodyHtml ?? '']
              .join(' ')
              .match(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)
              ?.map((match) => match.replace(/[{}\s]/g, '')) ?? [];
          for (const variable of used) {
            expect(allowed.has(variable), `${type.key} uses {{${variable}}}`).toBe(true);
          }
        }
      }
    }
  });

  it('falls back to English rather than to nothing', () => {
    // A person hearing about their own account in a second language beats silence.
    expect(
      defaultTemplate(NotificationType.SECURITY_PASSWORD_CHANGED.key, 'fr', 'EMAIL'),
    ).not.toBeNull();
  });
});

describe('channel resolution', () => {
  const type = NotificationType.SECURITY_SESSION_REVOKED;

  it('uses the type defaults when nobody has expressed a preference', () => {
    expect(channelsFor(type, null, AVAILABLE)).toEqual(['EMAIL', 'IN_APP']);
  });

  it('honours a preference that narrows the channels', () => {
    const preference = {
      channels: [NotificationChannel.IN_APP],
      digest: DigestFrequency.IMMEDIATE,
    };
    expect(channelsFor(type, preference, AVAILABLE)).toEqual(['IN_APP']);
  });

  it('refuses to let a preference silence a mandatory type', () => {
    // A person must be told their account changed. An attacker who can suppress the warning has
    // already won.
    const silenced = { channels: [], digest: DigestFrequency.IMMEDIATE };
    expect(channelsFor(type, silenced, AVAILABLE)).toEqual(['EMAIL', 'IN_APP']);
  });

  it('drops channels the deployment cannot deliver on', () => {
    // Queuing for a channel with no adapter is an outage nobody sees.
    expect(channelsFor(type, null, [NotificationChannel.EMAIL])).toEqual(['EMAIL']);
    const smsOnly = { channels: [NotificationChannel.SMS], digest: DigestFrequency.IMMEDIATE };
    expect(channelsFor(type, smsOnly, AVAILABLE)).toEqual(['EMAIL', 'IN_APP']);
  });
});

describe('digest windows', () => {
  it('sends a mandatory type immediately whatever the window says', () => {
    const daily = { channels: [], digest: DigestFrequency.DAILY };
    expect(shouldSendImmediately(NotificationType.SECURITY_SESSION_REVOKED, daily)).toBe(true);
  });
});

describe('the template renderer', () => {
  it('substitutes declared placeholders', () => {
    const result = render('Hello {{name}}', { name: 'Ada' }, ['name'], { escape: false });
    expect(result.text).toBe('Hello Ada');
    expect(result.failures).toEqual([]);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('Hi {{  name  }}', { name: 'Ada' }, ['name'], { escape: false }).text).toBe(
      'Hi Ada',
    );
  });

  it('evaluates nothing — there is no expression syntax to exploit', () => {
    // The whole grammar is a name between braces. A template is tenant-editable data, and an
    // engine that evaluated expressions would make editing one a way to run code.
    const result = render('{{ 1+1 }} {{name.constructor}}', { name: 'Ada' }, ['name'], {
      escape: false,
    });
    expect(result.text).toBe('{{ 1+1 }} {{name.constructor}}');
  });

  it('escapes values, but not the template around them', () => {
    const result = render('<p>{{name}}</p>', { name: '<script>alert(1)</script>' }, ['name'], {
      escape: true,
    });
    expect(result.text).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('reports a missing value rather than rendering a blank', () => {
    // "Document  was approved by " reaches a person looking like a defect, and nobody can tell
    // which value was lost.
    const result = render('Hello {{name}}', {}, ['name'], { escape: false });
    expect(result.failures).toEqual([{ reason: 'MISSING_VALUE', variable: 'name' }]);
  });

  it('reports a placeholder the type never declared', () => {
    const result = render('{{password}}', { password: 'x' }, ['name'], { escape: false });
    expect(result.failures).toEqual([{ reason: 'UNDECLARED_VARIABLE', variable: 'password' }]);
  });

  it('escapes every character that could close an attribute or a tag', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('rendering a whole message', () => {
  const template = {
    subject: 'Hello {{name}}',
    bodyText: 'Plain {{name}} & co',
    bodyHtml: '<p>{{name}} &amp; co</p>',
  };

  it('escapes only the HTML body', () => {
    const { message } = renderMessage(template, { name: 'A&B' }, ['name']);

    // The subject and text body reach a person as written; escaping them would show `&amp;`.
    expect(message?.subject).toBe('Hello A&B');
    expect(message?.bodyText).toBe('Plain A&B & co');
    expect(message?.bodyHtml).toBe('<p>A&amp;B &amp; co</p>');
  });

  it('returns nothing and every reason when a value is missing', () => {
    const { message, failures } = renderMessage(template, {}, ['name']);

    expect(message).toBeNull();
    // Three parts, three reports — an administrator fixing it is told everything at once.
    expect(failures).toHaveLength(3);
  });
});
