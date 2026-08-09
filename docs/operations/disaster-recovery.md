# Disaster recovery

**Purpose:** 20 §7's scenarios as procedures, each with what to do first and how you know it worked.
**Audience:** whoever is on call.

## 0. The two things to do before anything else

**Do not destroy the evidence.** Every procedure below restores *beside* the failure rather than
over it. A PITR onto a live database, a re-upload over a corrupted object, a re-provision of a lost
tenant — each removes the only record of what happened, and this product's whole value proposition
is that its records survive.

**Check the audit chain before anybody is pointed at recovered data.** It is the one assertion that
distinguishes a restore from a rewrite, and it takes minutes. Every procedure below ends with it for
that reason.

## 1. The scenarios

| Scenario | First action | Then | Done when |
| --- | --- | --- | --- |
| **API or worker instance lost** | Nothing. They are stateless and replaced automatically | Confirm `/api/health/ready` on the replacement | The instance is back in the load balancer |
| **Database primary lost** | Promote the replica; repoint the tenant's catalogue entry | Reconnect; the API's pools reconnect lazily per tenant | The chain verifies on the promoted primary |
| **Region lost** | Restore into the secondary region from replicated object storage and PITR; switch DNS | Per tenant, in contractual order — the catalogue is the list | Every tenant's chain verifies, and the integrity sweep reports no mismatches on a sample |
| **Storage object lost or corrupted** | §2 below | | |
| **Ransomware or destructive action** | §3 below | | |
| **Tenant-level mistake (mass delete)** | **Do not restore.** The recycle bin is the first line of defence | A restore of a soft delete is a restore of something that is not gone. [ADR-0010](../architecture/adr/0010-soft-delete-and-retention.md) | The documents are back and one cascade identifier reversed exactly one delete |
| **One tenant needs a point-in-time restore** | [backup-and-restore.md §2](./backup-and-restore.md) | Nobody else is touched, which is ADR-0015's operational dividend | That tenant's chain verifies |

## 2. A storage object lost or corrupted

Since Phase 18 this scenario usually starts with the product telling you rather than with a customer
telling you: the nightly integrity sweep re-reads stored blobs, re-hashes them, and on a mismatch
**quarantines the blob**, writes an `INTEGRITY_MISMATCH` audit row with both digests, and publishes
an event that reaches webhooks and any SIEM sink. 17 §9 lists a checksum mismatch as an immediate
alert.

1. **Read the audit row.** It carries the expected digest, what was found, the storage key and the
   driver. Both digests matter: "hashes to something else" is a different incident from "reads as
   absent", and the second one is often a permissions change rather than a loss.
2. **Do not clear the quarantine.** The blob is unreachable by exactly the gate an infected blob
   fails, and that is correct until the bytes are known-good again.
3. **Restore the object** from versioning or cross-region replication, into place.
4. **Re-run the sweep for that tenant.** A successful re-read sets the blob back to `VERIFIED` and
   makes it reachable again. Nothing else clears the quarantine, deliberately: an operator with a
   database connection cannot mark a blob good, because a blob marked good by a human is exactly
   what the control exists to prevent.
5. **If it is unrecoverable**, 20 §7's rule is absolute: *mark the revision and raise a compliance
   incident — never silently substitute.* The quarantine already does the first half. A substituted
   blob would be a controlled document whose content does not match its approval, which is the one
   failure this product may not have.

## 3. Ransomware or a destructive action

The order matters more here than anywhere else.

1. **Contain.** Revoke every session (`permVersion` forces re-evaluation on the next call), disable
   the API keys — a key is resolved on *every* request, so revocation is immediate rather than
   waiting out a token lifetime — and take the outbound allow-list to empty, which makes every
   webhook, federation and audit-push path inert.
2. **Do not restore yet.** Establish *when*, and the trail is how: the hash chain identifies exactly
   what was touched and when, and the audit table refuses `UPDATE` and `DELETE` to every role
   including the owner — so the attacker's own actions are in it unless they had the cluster.
3. **PITR to before the event, per tenant, into new databases.** Object versioning restores the
   blobs.
4. **Verify before opening.** Chain end to end; the last pre-incident checkpoint recomputes; the
   integrity sweep over a sample. The checkpoints are signed with a key held in neither the database
   nor the bucket, which is what makes step 4 meaningful against an attacker who reached both.
5. **Then** repoint the catalogue and reopen, tenant by tenant.

## 4. What this deliberately does not have

**No automated failover, and no orchestration for any of the above.** Every procedure here is a
person following steps, and that is the honest state rather than an ambition. Automating a database
promotion or a regional cutover is a piece of platform engineering with its own failure modes — a
split brain, a flapping promotion — and building half of one would produce a system that fails over
when it should not and does not when it should.

**No tested RTO — still, and for a narrower reason than before.** 20 §6's table states 2 hours for a
database and 4 for object storage. Phase 6.10 performed the first restore this product has ever had
([backup-and-restore.md §4](./backup-and-restore.md#4-what-has-and-has-not-been-performed)), so the
database procedure is no longer a hypothesis — but two small tenant databases restoring in 20.5
seconds is evidence that the *sequence* works, not that a customer's corpus fits inside two hours.
The object-storage figure has no measurement at all: nothing in that rehearsal restored a bucket.

Both remain targets. What changed is that the procedure behind them has been executed once, by
somebody who was not in an incident at the time.
