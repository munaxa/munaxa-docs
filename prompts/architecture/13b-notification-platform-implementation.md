# 13b — Notification Platform (Implementation Architecture)

> Implementation-grade companion to [`13-notification-architecture.md`](./13-notification-architecture.md).
> Munaxa ships **only two delivery channels — Push (FCM) and Email (Resend)** — plus the
> persistent in-app Notification Center. **No SMS, WhatsApp, or Telegram.** The legacy
> WhatsApp bridge framework is retained dormant behind a feature flag but is not part of the
> supported platform.

This document is the single source of truth for the production notification platform that
serves **1,000+ schools, 100,000+ users, and millions of notifications**. Every Munaxa module
emits **domain events**; modules **never** call FCM or Resend directly. The Notification Engine
owns resolution, preference enforcement, templating, and channel dispatch.

---

## 1. System architecture

```
 Attendance · Finance · Academics · Behavior · Admissions · Parent/Student/Teacher portals
        │  (emit typed domain events — never send mail/push directly)
        ▼
   NotificationEventBus  ──►  NotificationEngine
                                   │  1. resolve recipients (RBAC + tenant scope)
                                   │  2. load per-user NotificationPreference (+ mandatory override)
                                   │  3. apply PriorityEngine (channel selection + escalation)
                                   │  4. render bilingual NotificationTemplate (EN/AR)
                                   │  5. persist Notification (in-app, source of truth)
                                   ▼
                          NotificationQueuePort  (Push / Email / Retry / DLQ)
                                   ▼
                          ChannelDispatcher
                              ├─► PushChannel   → FCM (multi-device)
                              └─► EmailChannel  → Resend (settings-driven sender)
                                   ▼
                          NotificationDelivery  (per channel, per attempt, audited)
```

### Layering & ownership
| Layer | Owner module | Responsibility |
|-------|--------------|----------------|
| Event producers | every domain module | emit `NotificationEvent` via `NotificationEventBus` |
| Engine | `communication/engine` | recipient resolution, preference + priority, persistence |
| Queue | `communication/queue` | async hand-off, retry/backoff, DLQ (port + adapter) |
| Dispatch | `communication/dispatch` | per-channel send + delivery recording |
| Center | `communication/notifications` | in-app feed, unread, read-all, filters |
| Settings | `communication/settings` | tenant sender identity + global toggles |
| Preferences | `communication/preferences` | per-user, per-category opt-in/out |
| Templates | `communication/templates` | versioned bilingual templates |

---

## 2. Event architecture

Events are **typed, tenant-scoped, and idempotency-keyed**. The bus is an in-process
`EventEmitter2`-style facade today (`NotificationEventBus`) so producers stay decoupled from the
engine; the same interface backs a Redis Streams transport when the worker fleet is split out
(see §7). Producers depend only on `NotificationEventBus.emit(event)`.

```ts
type NotificationEvent = {
  type: EventType;            // AttendanceMarked, StudentAbsent, PaymentOverdue, ...
  tenantId: string;
  category: NotificationCategory; // ATTENDANCE | FINANCE | ACADEMIC | BEHAVIOR | ANNOUNCEMENT | SYSTEM
  priority: NotificationPriority; // CRITICAL | HIGH | NORMAL | LOW
  recipients: RecipientSpec;  // explicit userIds OR an audience query (role / section)
  context: Record<string, string | number>; // template variables ({{StudentName}}, {{Amount}}…)
  mandatory?: boolean;        // bypass user preferences (school-enforced)
  idempotencyKey?: string;    // default `${type}:${entityId}` — dedupe duplicate emits
};
```

### Catalogue (event → default category/priority)
| Event | Category | Priority |
|-------|----------|----------|
| `AttendanceMarked`, `StudentLate` | ATTENDANCE | NORMAL |
| `StudentAbsent` | ATTENDANCE | **HIGH** (escalates to email) |
| `HomeworkAssigned`, `HomeworkDue`, `GradePublished` | ACADEMIC | NORMAL |
| `BehaviorRecorded` | BEHAVIOR | NORMAL |
| `AnnouncementCreated` | ANNOUNCEMENT | NORMAL |
| `PaymentDue`, `PaymentReceived`, `RefundApproved` | FINANCE | NORMAL |
| `PaymentOverdue` | FINANCE | **HIGH** |
| `LeaveApproved`, `LeaveRejected`, `PTMBooked`, `DocumentUploaded`, `ReportPublished` | ACADEMIC/SYSTEM | NORMAL |
| `UserCreated`, `PasswordResetRequested`, `LoginOTPRequested` | SYSTEM | **CRITICAL** (push+email) |
| `EmergencyAlert`, `SchoolClosure`, `SecurityIncident` | SYSTEM | **CRITICAL** |

---

## 3. Priority engine

| Priority | Channels | Escalation | Examples |
|----------|----------|------------|----------|
| **CRITICAL** | Push **+** Email immediately | — | emergency, school closure, security, OTP, password reset |
| **HIGH** | Push first | if `readAt` still null after `escalateAfter` → send Email | student absent, payment overdue, PTM reminder |
| **NORMAL** | Push only | — | homework, grades, announcements |
| **LOW** | Email only (digestable) | — | weekly/monthly summaries, newsletters |

Channel set is computed by `PriorityEngine.channelsFor(priority)` then **intersected with**
(a) the tenant `NotificationSettings` global toggles and (b) the recipient `NotificationPreference`
for the category — **unless `mandatory` is true**, in which case preferences are bypassed but the
tenant kill-switches (`emailEnabled`/`pushEnabled`) are still honoured. HIGH escalation is driven
by a scheduled sweep (`escalateUnread`) that re-queues an email for unread HIGH notifications.

---

## 4. Preference engine

`NotificationPreference` is one row per `(tenantId, userId)` with a global `pushEnabled` /
`emailEnabled` plus a push+email pair per category (Attendance/Finance/Academic/Behavior/
Announcement/System). Resolution order for a `(user, category, channel)` triple:

1. tenant `NotificationSettings.{push,email}Enabled` is the hard kill-switch.
2. if event is `mandatory` → allowed (school-enforced; ignores user prefs).
3. else user global toggle AND the category-channel toggle must both be on.

Missing preference rows default to **opt-in** (lazily created on first read).

---

## 5. Database design — see [`prisma/schema.prisma`](../../prisma/schema.prisma)

| Model | Purpose | Key indexes |
|-------|---------|-------------|
| `Notification` | in-app item, source of truth (now bilingual + typed + priority + status) | `(tenantId,userId,readAt)`, `(tenantId,userId,createdAt)`, `(tenantId,status)` |
| `NotificationPreference` | per-user channel/category matrix | unique `(tenantId,userId)` |
| `NotificationTemplate` | versioned bilingual templates per event/channel/language | unique `(tenantId,eventType,channel,language)` |
| `NotificationDelivery` | one row per channel send attempt + provider response | `(tenantId,notificationId)`, `(tenantId,status)` |
| `NotificationAudit` | append-only action log per notification | `(tenantId,notificationId)`, `(tenantId,createdAt)` |
| `NotificationSettings` | tenant sender identity + global toggles | unique `tenantId` |
| `DeviceToken` | FCM tokens, multi-device, revocable (now `deviceType`/`active`) | `(tenantId,userId)`, `(tenantId,active)` |

All tables carry `tenantId` and are protected by **PostgreSQL RLS** (`FORCE ROW LEVEL SECURITY`,
`app_current_tenant()` policy) identical to the rest of the schema. Audit/delivery tables are
append-only (no UPDATE/DELETE policy under FORCE RLS).

---

## 6. Backend & API design

```
POST   /v1/notifications/devices                 register/refresh a device (deviceType, platform)
DELETE /v1/notifications/devices/:token          revoke a device
GET    /v1/notifications/me                       paged feed (cursor) + filters (category/priority/read/date/search)
GET    /v1/notifications/me/unread-count          badge counter
POST   /v1/notifications/:id/read                 mark one read
POST   /v1/notifications/read-all                 mark all read
POST   /v1/notifications/:id/archive              archive
GET    /v1/notifications/preferences              my preference matrix (lazy-created)
PUT    /v1/notifications/preferences              update my preferences
GET    /v1/notifications/settings                 tenant settings           (admin: notification:settings)
PUT    /v1/notifications/settings                 update sender/toggles      (admin)
GET    /v1/notifications/templates                list templates             (admin)
PUT    /v1/notifications/templates/:id            upsert template            (admin)
POST   /v1/notifications/:id/resend               manual resend of a delivery (admin: notification:send)
GET    /v1/notifications/analytics                sent/delivery/read/open/failed + trends (admin)
```

RBAC: end-user endpoints require auth + self-scope; admin endpoints add
`NOTIFICATION_SETTINGS` / `NOTIFICATION_SEND`. Every state-changing call writes a
`NotificationAudit` row in the same transaction.

---

## 7. Queue architecture

`NotificationQueuePort` abstracts the broker. **Phase 1 (this PR):** an in-process async worker
with bounded concurrency + exponential backoff + attempt cap, persisting every attempt to
`NotificationDelivery` and dead-lettering to `status=FAILED` after `maxAttempts`. **Phase 2:**
swap in a **BullMQ + Redis** adapter (queues: `notify`, `push`, `email`, `retry`, `dlq`) with a
dedicated worker process and horizontal scaling — the port keeps producers and the engine
unchanged. Requirements baked into the port contract: background processing, exponential backoff
(`2^n` capped), retry limit, failure tracking, bulk enqueue, and manual resend.

---

## 8. Templates

Stored bilingual (EN/AR) per `(eventType, channel, language)`. Variables use `{{Mustache}}`
syntax: `{{SchoolName}}`, `{{StudentName}}`, `{{ParentName}}`, `{{TeacherName}}`, `{{Amount}}`,
`{{DueDate}}`, `{{ClassName}}`, `{{AttendanceDate}}`. The renderer escapes HTML, falls back to a
built-in default template when no tenant override exists, and always emits a plain-text
alternative for email deliverability. RTL is applied for `ar`.

---

## 9–12. Client surfaces (Admin / Parent / Student / Teacher)

The Notification Center is a shared experience built on the same API: unread counter, read-all,
archive, search, category/priority/date filters, and cursor-based infinite scroll. Web (Admin)
uses the Munaxa Design System components; the Flutter apps (Parent/Student/Teacher) use Riverpod
providers over the same `/v1/notifications/*` endpoints with FCM token registration on login and
revocation on logout. Admins additionally get Settings, Templates, and the Analytics dashboard.

## 13. Security
RBAC on every endpoint, tenant isolation via RLS, append-only audit on every action, DTO
validation (class-validator), rate limiting on device registration + resend, FCM token format
validation + invalid-token pruning, and template variable allow-listing.

## 14. Analytics
`GET /analytics` aggregates from `NotificationDelivery` + `Notification`: notifications sent, push
& email delivery rate, read rate, open rate, failed deliveries, top categories, daily/monthly
trends, and total volume — all tenant-scoped.

## 15. Testing
Unit (priority + preference resolution, template render), integration (engine→queue→delivery),
e2e (center endpoints, settings RBAC), queue (retry/backoff/DLQ), RBAC and RLS isolation, and
failure-recovery (provider rejection → retry → DLQ → manual resend).

## 16. Deployment
API on AWS (ECS/Fargate) behind Cloudflare; Phase-2 worker fleet as separate autoscaled service
consuming Redis queues. Secrets (`RESEND_API_KEY`, `FIREBASE_*`) via env/Secrets Manager. Sender
identity is **never hardcoded** — it lives in `NotificationSettings` (defaults: `Munaxa
Notifications <notification@munaxa.com>`, reply-to `support@munaxa.com`) and is editable from the
Admin Portal.
