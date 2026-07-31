# ADR-0003 — Document, revision and file are three separate records

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

The simplest model for a document system is a row with a file attached, and a `version` column.
Every EDMS that starts there eventually discovers that the identity, the controlled version and the
bytes have different lifetimes, different immutability rules and different ownership:

- The **identity** carries the document number that appears in printed copies and contracts. It must
  survive every revision, every move and even deletion.
- The **revision** is what an approver approved. It must be immutable afterwards, forever.
- The **bytes** may be identical across revisions or across documents, and are the only part that is
  expensive to store.

## Decision

Three records:

| Record | Identity | Mutability |
| --- | --- | --- |
| `Document` | The controlled record: number, type, owner, location, status | Metadata and location may change; the number never does |
| `DocumentRevision` | One controlled version: ordinal, label, author, approval record, metadata snapshot | Immutable once published |
| `FileObject` | Stored bytes: checksum, size, MIME, storage key | Immutable, always; content-addressed and reference-counted |

A revision references a file; many revisions may reference the same file. A document references its
current published revision and its latest revision.

## Alternatives considered

1. **One row with a version number and a file path** — cannot express "the bytes an approver
   approved are unchanged", cannot dedupe, and turns revision history into a delete-and-replace.
2. **Revisions as copies of the document row** — duplicates every metadata field per revision, and
   makes "which is current" a query rather than a fact.
3. **File as an attachment collection on the document** — loses the binding between an approval and
   the exact bytes it approved.

## Consequences

- Reverting content costs no storage: the old `FileObject` is referenced again.
- "Prove what was approved" is answerable: revision → file → checksum.
- Three tables and explicit reference counting, rather than one table. This is the price, and it is
  paid once.
- Deleting a document never deletes bytes directly; purge decrements references and blobs are
  removed at zero ([11](../11-storage-architecture.md)).
