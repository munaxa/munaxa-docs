import { describe, expect, it } from 'vitest';

import {
  ProxyTrustError,
  clientAddressOf,
  compileProxyTrust,
  normalizeAddress,
  parseProxyTrust,
} from './proxy-trust';

const resolve = (raw: string, socket: string, forwardedFor?: string): string | undefined =>
  clientAddressOf(socket, forwardedFor, compileProxyTrust(parseProxyTrust(raw)));

describe('parseProxyTrust', () => {
  it('trusts nothing when unset, empty, false or zero', () => {
    for (const raw of [undefined, '', '  ', 'false', 'FALSE', '0']) {
      expect(parseProxyTrust(raw)).toEqual({ kind: 'NONE' });
    }
  });

  it('reads a hop count', () => {
    expect(parseProxyTrust('2')).toEqual({ kind: 'HOPS', hops: 2 });
  });

  it('reads addresses, ranges and the named ranges', () => {
    expect(parseProxyTrust(' 10.0.0.5, 10.1.0.0/16 ,loopback, fd00::/8 ')).toEqual({
      kind: 'ADDRESSES',
      entries: ['10.0.0.5', '10.1.0.0/16', 'loopback', 'fd00::/8'],
    });
  });

  it.each(['true', 'TRUE', '*', 'all'])('refuses %s, which would trust every address', (raw) => {
    expect(() => parseProxyTrust(raw)).toThrow(ProxyTrustError);
    // And says why, rather than calling it a malformed address: the operator meant it.
    expect(() => parseProxyTrust(raw)).toThrow(/would trust every address/);
  });

  it.each(['11', 'proxy.internal', '10.0.0.0/33', '10.0.0.0/8/1', '::1/129', '10.0.0.0/x'])(
    'refuses %j as an entry',
    (raw) => {
      expect(() => parseProxyTrust(raw)).toThrow(ProxyTrustError);
    },
  );
});

describe('clientAddressOf', () => {
  it('is the socket when nothing is trusted, whatever the header claims', () => {
    expect(resolve('', '203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
  });

  it('is the socket when there is no header', () => {
    expect(resolve('loopback', '127.0.0.1')).toBe('127.0.0.1');
  });

  it('takes the address a trusted proxy appended', () => {
    expect(resolve('10.0.0.0/8', '10.0.0.5', '198.51.100.7')).toBe('198.51.100.7');
  });

  it('ignores what the client wrote to the left of what the trusted proxy appended', () => {
    // The client sent `X-Forwarded-For: 1.2.3.4`; the proxy appended the address it saw.
    expect(resolve('10.0.0.0/8', '10.0.0.5', '1.2.3.4, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('refuses the header from a sender that is not a trusted proxy', () => {
    expect(resolve('10.0.0.0/8', '198.51.100.7', '1.2.3.4')).toBe('198.51.100.7');
  });

  it('walks through several trusted hops and stops at the first untrusted one', () => {
    expect(resolve('10.0.0.0/8', '10.0.0.5', '1.2.3.4, 198.51.100.7, 10.0.0.9')).toBe(
      '198.51.100.7',
    );
  });

  it('is the furthest entry when every hop is trusted', () => {
    expect(resolve('10.0.0.0/8', '10.0.0.5', '10.0.0.7, 10.0.0.9')).toBe('10.0.0.7');
  });

  it('counts hops rather than addresses when given a number', () => {
    expect(resolve('1', '10.0.0.5', '1.2.3.4, 198.51.100.7')).toBe('198.51.100.7');
    expect(resolve('2', '10.0.0.5', '1.2.3.4, 198.51.100.7')).toBe('1.2.3.4');
  });

  it('stops at the reporting hop when a trusted proxy passes on something that is not an address', () => {
    expect(resolve('10.0.0.0/8', '10.0.0.5', 'unknown')).toBe('10.0.0.5');
    expect(resolve('1', '10.0.0.5', 'not-an-ip')).toBe('10.0.0.5');
  });

  it('treats an IPv4-mapped socket as the IPv4 address', () => {
    expect(resolve('127.0.0.1', '::ffff:127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(resolve('', '::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('matches IPv6 ranges', () => {
    expect(resolve('fd00::/8', 'fd00::5', '2001:db8::1')).toBe('2001:db8::1');
    expect(resolve('fd00::/8', 'fe80::5', '2001:db8::1')).toBe('fe80::5');
  });

  it('accepts the header as a list of values', () => {
    expect(
      clientAddressOf(
        '10.0.0.5',
        ['1.2.3.4', '198.51.100.7'],
        compileProxyTrust(parseProxyTrust('10.0.0.5')),
      ),
    ).toBe('198.51.100.7');
  });

  it('has no answer without a socket address', () => {
    expect(resolve('loopback', '', '198.51.100.7')).toBeUndefined();
  });
});

describe('normalizeAddress', () => {
  it('unwraps an IPv4-mapped IPv6 address and leaves others alone', () => {
    expect(normalizeAddress('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeAddress('::1')).toBe('::1');
    expect(normalizeAddress(' 10.1.2.3 ')).toBe('10.1.2.3');
  });
});
