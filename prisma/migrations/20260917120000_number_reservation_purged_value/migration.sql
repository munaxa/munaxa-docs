-- `PURGED`, the fifth reservation state — Slice 105A, part one of two.
--
-- Split from the constraint that uses it because PostgreSQL will not let a value added by
-- `ALTER TYPE ... ADD VALUE` be *used* in the transaction that added it. Prisma runs each
-- migration in its own transaction, so the value lands here and the constraint that names it
-- lands in the migration beside this one.
--
-- `IF NOT EXISTS` for the reason `20260805190000_delegation` gives: re-running a migration
-- against a database that already carries the value is not a failure.
ALTER TYPE "number_reservation_state" ADD VALUE IF NOT EXISTS 'PURGED';
