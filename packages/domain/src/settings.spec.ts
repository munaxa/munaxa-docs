import { describe, expect, it } from 'vitest';

import { ALL_SETTINGS, Settings, isSettingKey, resolveSettings, settingFor } from './settings';

describe('the settings catalogue', () => {
  it('declares every setting exactly once', () => {
    const keys = ALL_SETTINGS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every setting a default that is itself valid', () => {
    // A default the parser would reject is a setting nobody can ever store the default of.
    for (const definition of ALL_SETTINGS) {
      expect(definition.parse(definition.defaultValue)).toEqual(definition.defaultValue);
    }
  });

  it('narrows an untrusted key to the catalogue', () => {
    expect(isSettingKey('locale.default')).toBe(true);
    expect(isSettingKey('locale.invented')).toBe(false);
    expect(settingFor('locale.default')).toBe(Settings.DEFAULT_LOCALE);
    expect(settingFor('locale.invented')).toBeNull();
  });
});

describe('parsing', () => {
  it('accepts a value from the allowed set and refuses one outside it', () => {
    expect(Settings.DEFAULT_LOCALE.parse('ar')).toBe('ar');
    expect(Settings.DEFAULT_LOCALE.parse('fr')).toBeNull();
    expect(Settings.DEFAULT_LOCALE.parse(7)).toBeNull();
  });

  it('trims, and treats an empty string as no value at all', () => {
    expect(Settings.TIMEZONE.parse('  Asia/Amman ')).toBe('Asia/Amman');
    expect(Settings.TIMEZONE.parse('   ')).toBeNull();
  });

  it('refuses a number outside its bounds rather than clamping it', () => {
    // A stored 4 where the minimum is 8 is someone's mistake; honouring 8 would hide it.
    expect(Settings.PASSWORD_MINIMUM_LENGTH.parse(4)).toBeNull();
    expect(Settings.PASSWORD_MINIMUM_LENGTH.parse(16)).toBe(16);
    expect(Settings.PASSWORD_MINIMUM_LENGTH.parse(12.5)).toBeNull();
    expect(Settings.PASSWORD_MINIMUM_LENGTH.parse('16')).toBeNull();
  });

  it('never lets a tenant configure a password shorter than the standard floor', () => {
    expect(Settings.PASSWORD_MINIMUM_LENGTH.parse(7)).toBeNull();
    expect(Settings.PASSWORD_MINIMUM_LENGTH.parse(8)).toBe(8);
  });

  it('refuses a truthy string where a boolean belongs', () => {
    expect(Settings.PASSWORD_FORBID_IDENTIFIERS.parse('true')).toBeNull();
    expect(Settings.PASSWORD_FORBID_IDENTIFIERS.parse(false)).toBe(false);
  });
});

describe('resolveSettings', () => {
  it('returns every declared setting, whether stored or not', () => {
    const { values } = resolveSettings({});

    expect(Object.keys(values).sort()).toEqual(ALL_SETTINGS.map((d) => d.key).sort());
    expect(values['locale.default']).toBe('en');
  });

  it('prefers a stored value over the default', () => {
    const { values, fellBack } = resolveSettings({ 'locale.default': 'ar' });

    expect(values['locale.default']).toBe('ar');
    expect(fellBack).toEqual([]);
  });

  it('falls back to the default when a stored value cannot be used, and says so', () => {
    const { values, fellBack } = resolveSettings({ 'security.password.minimumLength': 2 });

    expect(values['security.password.minimumLength']).toBe(12);
    expect(fellBack).toEqual(['security.password.minimumLength']);
  });

  it('reports a stored key the catalogue does not declare', () => {
    const { values, unrecognised } = resolveSettings({ 'locale.retired': 'x' });

    expect(values['locale.retired']).toBeUndefined();
    expect(unrecognised).toEqual(['locale.retired']);
  });

  it('is complete and valid even for a bag of nonsense', () => {
    // Settings are read on paths that must keep working; resolution cannot throw.
    const { values } = resolveSettings({
      'locale.default': null,
      'locale.timezone': [],
      'security.password.minimumLength': 'twelve',
      'security.session.idleTimeoutMinutes': -1,
    });

    for (const definition of ALL_SETTINGS) {
      expect(values[definition.key]).toEqual(definition.defaultValue);
    }
  });
});
