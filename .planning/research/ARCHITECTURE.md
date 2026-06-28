# Architecture Research

**Domain:** GSD Cloud — email notifications, notification preferences, daily digest, admin panel
**Researched:** 2026-06-28
**Confidence:** HIGH (Better Auth admin plugin, Resend batch API verified from docs; patterns from established production SaaS kits)

---

## Context: What Already Exists (Phase 1-2 Foundation)

This file covers **only net-new components for this milestone**. The existing architecture established in prior milestones:

- `web/app/(auth)/` — sign-in, sign-up, OAuth (Better Auth)
- `web/app/(dashboard)/` — auth-gated layout with machine list, activity feed
- `web/lib/cloud-auth.ts` — Better Auth server instance (admin plugin NOT yet added)
- `packages/db/src/schema/auth.ts` — user, session, account, verification tables
- `packages/db/src/schema/devices.ts` — pairingTokens, devices tables
- `packages/db/src/schema/activity.ts` — activity_events table (Milestone 2)
- `packages/db/src/schema/preferences.ts` — user_preferences with `notificationsEnabled: boolean` (Milestone 2)
- Resend already installed (`resend@^6.14.0`) and used for verification/password reset emails
- `@react-email/components` already installed for email templates
- SSE pattern already established in `web/lib/auth.ts` (`_token` query param for EventSource)
- Stripe integration exists with webhook handler

The `user_preferences` table from Milestone 2 provides the `notificationsEnabled` boolean. This milestone expands it to per-type, per-channel granularity, and adds a `notifications` in-app table, a digest job table, a feature flags table, and the admin plugin wiring.

---

## Standard Architecture for This Milestone

### System Overview

```
Browser (React 19 + Next.js App Router)
+--------------------------------------------------------------------------+
|                                                                          |
|  +---------------------+  +----------------------------+                 |
|  | NotificationBell    |  | Admin Panel                |                 |
|  | (Popover + badge)   |  | /admin/* route group       |                 |
|  | SSE real-time push  |  | UserTable, MetricsDash,    |                 |
|  | + read/dismiss      |  | FeatureFlags, Impersonate  |                 |
|  +----------+----------+  +-------------+--------------+                 |
|             |                           |                                |
|  +----------v---------------------------v---------+                      |
|  |   cloud-auth-client.ts (Better Auth + adminClient plugin)             |
|  |   + fetch() with session cookie                                       |
|  +------------------------------------------+---+                      |
+---------------------------------------------|-----------------------------+
                                              | HTTPS
+---------------------------------------------v---------------------------+
|               Next.js App Router (web/)                                  |
|                                                                          |
|  /admin/                        /api/                                    |
|  layout.tsx [ADMIN GATE]        notifications/route.ts    [NEW]          |
|  page.tsx   [metrics]           notifications/[id]/route.ts [NEW]        |
|  users/page.tsx                 notifications/sse/route.ts [NEW]         |
|  users/[id]/page.tsx            notification-preferences/route.ts [NEW]  |
|  feature-flags/page.tsx         admin/users/route.ts       [NEW]         |
|  feature-flags/[id]/page.tsx    admin/metrics/route.ts     [NEW]         |
|                                 admin/feature-flags/route.ts [NEW]       |
|  /api/cron/                     admin/impersonate/route.ts  [NEW]        |
|  daily-digest/route.ts [NEW]    cron/daily-digest/route.ts  [NEW]        |
|                                                                          |
|  +-------------------------------------------------------------------+   |
|  |  cloud-auth.ts — add admin() plugin                               |   |
|  +--------------------------------------+----------------------------+   |
+----------------------------------------|---------------------------------+
                                         | @neondatabase/serverless (HTTP)
+-----------------------------------------v--------------------------------+
|              Neon Postgres (packages/db/src/schema/)                     |
|                                                                          |
|  user (+role +banned)  session (+impersonatedBy) [Better Auth admin]     |
|  notifications                                   [NEW — in-app store]    |
|  notification_preferences                        [NEW — per-type/channel]|
|  digest_jobs                                     [NEW — cron tracking]   |
|  feature_flags                                   [NEW — admin toggles]   |
|  user_feature_overrides                          [NEW — per-user flags]  |
|  activity_events  user_preferences  devices      [existing]              |
+---------------------------------------------------------------------------+
                    |
                    | Vercel Cron (vercel.json)
+-----------------------------------------v--------------------------------+
|  /api/cron/daily-digest                                                  |
|  Reads: users with digest enabled, activity since last digest            |
|  Writes: resend.emails.batch() — up to 100/call, 2 calls/sec            |
|  Tracks: digest_jobs row per run (status, sent_count, errors)            |
+---------------------------------------------------------------------------+
```

### Component Responsibilities

| Component | Responsibility | Location |
|-----------|----------------|----------|
| `admin()` plugin in cloud-auth | Adds role, banned, impersonatedBy DB fields; exposes admin API methods | `web/lib/cloud-auth.ts` — MODIFY |
| `adminClient()` in cloud-auth-client | Exposes `authClient.admin.*` methods for admin UI | `web/lib/cloud-auth-client.ts` — MODIFY |
| `/admin/layout.tsx` | Server component: verifies session.user.role === 'admin', redirects otherwise | `web/app/(admin)/layout.tsx` — NEW |
| `/admin/page.tsx` | Metrics dashboard: user counts, active devices, recent activity, subscription stats | `web/app/(admin)/page.tsx` — NEW |
| `/admin/users/page.tsx` | Paginated user table: search, filter by role/ban status, click-through to user detail | `web/app/(admin)/users/page.tsx` — NEW |
| `/admin/users/[id]/page.tsx` | User detail: profile, devices, sessions, ban/unban, impersonate, role change | `web/app/(admin)/users/[id]/page.tsx` — NEW |
| `/admin/feature-flags/page.tsx` | Feature flag list: global toggles, per-user override table | `web/app/(admin)/feature-flags/page.tsx` — NEW |
| `NotificationBell` | Popover showing unread in-app notifications; SSE connection for real-time count push | `web/components/gsd/cloud/notification-bell.tsx` — NEW |
| `NotificationPreferencesPanel` | Settings page for per-type/per-channel notification frequency | `web/components/gsd/cloud/notification-preferences.tsx` — NEW |
| `/api/notifications/route.ts` | GET paginated list + PATCH mark-read + DELETE dismiss | `web/app/api/cloud/notifications/route.ts` — NEW |
| `/api/notifications/sse/route.ts` | SSE stream: pushes unread count on new notification insert | `web/app/api/cloud/notifications/sse/route.ts` — NEW |
| `/api/notification-preferences/route.ts` | GET user prefs + PATCH update per-type/channel settings | `web/app/api/cloud/notification-preferences/route.ts` — NEW |
| `/api/cron/daily-digest/route.ts` | Cron handler: queries eligible users, batches digest sends via Resend batch API | `web/app/api/cron/daily-digest/route.ts` — NEW |
| `/api/admin/users/route.ts` | Admin: list/search users (delegates to `authClient.admin.listUsers`) | `web/app/api/admin/users/route.ts` — NEW |
| `/api/admin/users/[id]/route.ts` | Admin: get user, setRole, banUser, unbanUser, revokeAllSessions | `web/app/api/admin/users/[id]/route.ts` — NEW |
| `/api/admin/impersonate/route.ts` | Admin: start/stop impersonation session | `web/app/api/admin/impersonate/route.ts` — NEW |
| `/api/admin/feature-flags/route.ts` | Admin: CRUD feature flags and per-user overrides | `web/app/api/admin/feature-flags/route.ts` — NEW |
| `/api/admin/metrics/route.ts` | Admin: aggregate stats (user counts, device counts, notification volume) | `web/app/api/admin/metrics/route.ts` — NEW |
| `web/emails/notification-digest.tsx` | React Email template for daily digest | `web/emails/notification-digest.tsx` — NEW |
| `web/emails/critical-alert.tsx` | React Email template for critical alerts (machine offline >1hr) | `web/emails/critical-alert.tsx` — NEW |

---

## Recommended Project Structure

```
web/
+-- app/
|   +-- (admin)/                          NEW route group
|   |   +-- layout.tsx                    admin role gate (server component)
|   |   +-- page.tsx                      metrics overview
|   |   +-- users/
|   |   |   +-- page.tsx                  paginated user table
|   |   |   +-- [id]/page.tsx             user detail + actions
|   |   +-- feature-flags/
|   |       +-- page.tsx                  flag list + user overrides
|   |       +-- [id]/page.tsx             flag detail + targeting rules
|   +-- (dashboard)/
|   |   +-- settings/
|   |       +-- notifications/page.tsx    NEW: notification preferences UI
|   +-- api/
|       +-- cloud/
|       |   +-- notifications/
|       |   |   +-- route.ts              GET list, PATCH mark-read, DELETE dismiss
|       |   |   +-- [id]/route.ts         single notification ops
|       |   |   +-- sse/route.ts          SSE stream for real-time push
|       |   +-- notification-preferences/
|       |       +-- route.ts              GET + PATCH
|       +-- admin/
|       |   +-- metrics/route.ts          aggregate stats
|       |   +-- users/route.ts            list/search
|       |   +-- users/[id]/route.ts       get/ban/role/sessions
|       |   +-- impersonate/route.ts      start/stop impersonation
|       |   +-- feature-flags/route.ts    CRUD flags
|       |   +-- feature-flags/[id]/route.ts  flag detail + overrides
|       +-- cron/
|           +-- daily-digest/route.ts     Vercel Cron handler
+-- components/gsd/cloud/
|   +-- notification-bell.tsx             NEW: popover + SSE hook
|   +-- notification-preferences.tsx      NEW: settings panel
|   +-- admin/                            NEW subdirectory
|       +-- user-table.tsx                paginated data table
|       +-- user-detail-card.tsx          profile + actions (ban, impersonate, role)
|       +-- metrics-overview.tsx          stats cards + charts
|       +-- feature-flag-table.tsx        flag list with toggles
|       +-- impersonate-banner.tsx        "You are viewing as X" bar when impersonating
+-- emails/
|   +-- notification-digest.tsx           NEW: daily digest React Email template
|   +-- critical-alert.tsx                NEW: machine offline alert template
+-- lib/
    +-- cloud/
        +-- use-notifications.ts          polling/SSE hook for notification bell
        +-- use-notification-prefs.ts     fetch + optimistic update hook
        +-- feature-flags.ts              server-side flag evaluation helper

packages/db/src/schema/
+-- notifications.ts                      NEW: in-app notification store
+-- notification-preferences.ts           NEW: per-type/channel prefs
+-- digest-jobs.ts                        NEW: cron run tracking
+-- feature-flags.ts                      NEW: flag definitions + user overrides
+-- index.ts                              MODIFY: export new schemas
```

### Structure Rationale

- **`(admin)` route group**: Isolates admin pages so the layout server component can enforce the role check once, at the group boundary, rather than in every page. Follows the same pattern as `(auth)` and `(dashboard)` route groups already in place.
- **`api/cloud/` prefix for user-facing endpoints**: Separates user-facing cloud API routes from admin endpoints. The `/api/admin/` subtree has stricter authorization requirements and is clearly namespaced for future rate limiting or audit logging.
- **`api/cron/` subtree**: Vercel Cron routes are invoked via HTTP GET with an `Authorization: Bearer $CRON_SECRET` header. Keeping them under `/api/cron/` makes it obvious which routes are not user-callable and simplifies IP allowlisting if needed.
- **`web/emails/` directory**: React Email templates alongside the web app source. The templates are rendered server-side and have no client-side dependency — keeping them here is simpler than a shared package.
- **`components/gsd/cloud/admin/`**: Admin UI components are distinct from user-facing components. The data they display (all users' data, aggregate metrics) has different authorization context than per-user dashboard components.

---

## Architectural Patterns

### Pattern 1: Better Auth Admin Plugin Integration

**What:** Add `admin()` to the existing `betterAuth()` config and `adminClient()` to the auth client. This adds `role`, `banned`, `banReason`, `banExpires` columns to the `user` table and `impersonatedBy` to the `session` table via Drizzle migration.

**When to use:** The admin plugin is the correct integration for user management, banning, and impersonation. Do not build custom role-checking middleware — the plugin's `hasPermission` method handles this.

**Trade-offs:** The plugin's `listUsers` pagination is API-driven (client SDK calls under the hood hit `POST /api/auth/admin/list-users`). For admin metrics requiring DB aggregations (COUNT by plan, daily active users), write dedicated Drizzle queries in `/api/admin/metrics/route.ts` — the admin plugin doesn't provide aggregate queries.

```typescript
// web/lib/cloud-auth.ts — extend existing betterAuth() config
import { admin } from 'better-auth/plugins'

export const auth = betterAuth({
  // ... existing config
  plugins: [
    admin({
      impersonationSessionDuration: 60 * 60, // 1 hour (default)
      defaultRole: 'user',
    }),
  ],
})

// web/lib/cloud-auth-client.ts
import { adminClient } from 'better-auth/client/plugins'
export const authClient = createAuthClient({
  plugins: [adminClient()],
})
```

```typescript
// Admin role gate — web/app/(admin)/layout.tsx (server component)
import { headers } from 'next/headers'
import { auth } from '@/lib/cloud-auth'
import { redirect } from 'next/navigation'

export default async function AdminLayout({ children }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session || session.user.role !== 'admin') redirect('/dashboard')
  return <>{children}</>
}
```

### Pattern 2: In-App Notifications — DB Table + SSE Push

**What:** Notifications are written server-side to a `notifications` table. The `NotificationBell` component connects to an SSE stream (`/api/cloud/notifications/sse`) which pushes the current unread count whenever a new notification is inserted. Client reads the full list on open via REST.

**When to use:** Any server-generated alert that should appear in the notification bell without requiring a page reload.

**Trade-offs:** SSE is unidirectional (server → client). The client dismisses/marks-read via REST PATCH, not SSE. The SSE connection competes with the daemon's WebSocket relay connection — both are held open per browser tab. This is acceptable at current scale (2 persistent connections per active tab is standard SaaS practice). SSE auto-reconnects via the browser's `EventSource` API; no reconnection logic needed client-side. Add `export const dynamic = 'force-dynamic'` to the SSE route to prevent Next.js static optimization breaking streaming.

```typescript
// web/app/api/cloud/notifications/sse/route.ts
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return new Response('Unauthorized', { status: 401 })

  const stream = new ReadableStream({
    async start(controller) {
      const sendCount = async () => {
        const count = await db.select({ count: sql<number>`count(*)` })
          .from(notifications)
          .where(and(
            eq(notifications.userId, session.user.id),
            isNull(notifications.readAt),
          ))
        const data = `data: ${JSON.stringify({ unreadCount: count[0].count })}\n\n`
        controller.enqueue(new TextEncoder().encode(data))
      }
      await sendCount()
      // Poll every 30s as SSE keepalive + count refresh
      const interval = setInterval(sendCount, 30_000)
      request.signal.addEventListener('abort', () => {
        clearInterval(interval)
        controller.close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
```

**Note:** For real-time push (instant count update when relay inserts a notification), the relay's server-to-service POST to `/api/cloud/notifications` can be extended to broadcast via a lightweight in-memory event emitter (or `pg_notify`) to wake the SSE stream. At v1 scale, the 30s polling fallback in the SSE keepalive is acceptable — add true push only if users report staleness.

### Pattern 3: Notification Preferences — Normalized Table, Not JSONB Blob

**What:** Notification preferences use a normalized table with `(userId, notificationType, channel)` as composite primary key and `frequency` as an enum column. This allows O(1) lookup of "should I email this user for this notification type" without deserializing a JSONB blob.

**When to use:** Any time preferences have multiple independent dimensions (type × channel × frequency). The normalized table lets you add new notification types without schema migrations.

**Trade-offs:** More rows than a single JSONB column per user, but the query pattern is simpler and the indexes are efficient. Default preferences are implicit (row absent = use default). The alternative — JSONB blob — has no DB-level constraints and requires deserializing the whole blob to check one preference.

```typescript
// packages/db/src/schema/notification-preferences.ts
import { pgTable, text, primaryKey, pgEnum } from 'drizzle-orm/pg-core'
import { user } from './auth.js'

export const notificationFrequencyEnum = pgEnum('notification_frequency', [
  'immediate',
  'daily_digest',
  'never',
])

export const notificationChannelEnum = pgEnum('notification_channel', [
  'email',
  'in_app',
])

export const notificationPreferences = pgTable('notification_preferences', {
  userId:           text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  notificationType: text('notification_type').notNull(),
  // e.g. 'machine_offline' | 'task_completed' | 'team_invite' | 'critical_alert'
  channel:          notificationChannelEnum('channel').notNull(),
  frequency:        notificationFrequencyEnum('frequency').notNull().default('immediate'),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.notificationType, table.channel] }),
}))
```

**Default behavior:** If no row exists for `(userId, notificationType, channel)`, treat as `immediate` for `in_app` and `daily_digest` for `email`. This means new notification types work correctly for all existing users without a migration to backfill rows.

### Pattern 4: Daily Digest — Vercel Cron + Resend Batch API

**What:** A Vercel Cron job (defined in `vercel.json`) triggers `/api/cron/daily-digest` once per day. The handler queries users with at least one undigested activity, groups notifications per user, and sends batched emails via Resend's batch API (up to 100 per call, 2 calls/sec rate limit).

**When to use:** Scheduled email aggregation at any volume. This pattern scales to ~10K users without Redis or a separate queue service.

**Trade-offs:** Vercel Cron is best-effort (can miss a run on transient errors). Design the handler to be idempotent: track sent digests in a `digest_jobs` table; on re-run, skip users who already received today's digest. The `scheduled_at` parameter is NOT supported in Resend's batch API — each batch must be triggered at the scheduled time by the cron job itself, not pre-scheduled in Resend.

```typescript
// vercel.json
{
  "crons": [
    { "path": "/api/cron/daily-digest", "schedule": "0 8 * * *" }
  ]
}

// web/app/api/cron/daily-digest/route.ts
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Verify Vercel Cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Get users with pending digest notifications (email pref = daily_digest, no digest sent today)
  const users = await db.select(...)
    .from(user)
    .innerJoin(notificationPreferences, ...)
    .leftJoin(digestJobs, ...) // filter: no digest sent today
    .where(eq(notificationPreferences.frequency, 'daily_digest'))

  // Chunk into batches of 100 (Resend limit)
  for (const batch of chunk(users, 100)) {
    const emails = batch.map(u => ({
      from: process.env.EMAIL_FROM!,
      to: u.email,
      subject: 'Your GSD daily digest',
      react: <NotificationDigest user={u} notifications={u.pendingNotifications} />,
    }))
    await resend.emails.batch(emails)
    await new Promise(r => setTimeout(r, 500)) // respect 2 req/sec limit
  }

  return Response.json({ ok: true, sent: users.length })
}
```

### Pattern 5: Feature Flags — Postgres Table, Server-Evaluated

**What:** Feature flags are stored in a `feature_flags` table (id, name, description, enabled, rolloutPercent). Per-user overrides go in `user_feature_overrides` (flagId, userId, enabled). Flag evaluation happens in server components and is passed as props — never fetched client-side.

**When to use:** Any admin-toggled capability that needs to be on/off per-user or globally. Start here before reaching for LaunchDarkly — this pattern handles 100% of typical early-stage SaaS flag needs.

**Trade-offs:** No real-time propagation to already-rendered pages (user must reload). For flags controlling layout/features on page load this is fine. If a flag controls a streaming long-poll feature, evaluate it at connection establishment, not mid-stream. The admin panel toggles take effect on next request — acceptable.

```typescript
// packages/db/src/schema/feature-flags.ts
export const featureFlags = pgTable('feature_flags', {
  id:             text('id').primaryKey().$defaultFn(() => createId()),
  name:           text('name').notNull().unique(),
  description:    text('description'),
  enabled:        boolean('enabled').notNull().default(false),
  rolloutPercent: integer('rollout_percent').notNull().default(100),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
})

export const userFeatureOverrides = pgTable('user_feature_overrides', {
  flagId:  text('flag_id').notNull().references(() => featureFlags.id, { onDelete: 'cascade' }),
  userId:  text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.flagId, table.userId] }),
}))
```

```typescript
// web/lib/cloud/feature-flags.ts — server-side helper
export async function isFeatureEnabled(flagName: string, userId: string): Promise<boolean> {
  const override = await db.query.userFeatureOverrides.findFirst({
    where: and(
      eq(userFeatureOverrides.userId, userId),
      inArray(userFeatureOverrides.flagId,
        db.select({ id: featureFlags.id })
          .from(featureFlags)
          .where(eq(featureFlags.name, flagName))
      ),
    ),
  })
  if (override) return override.enabled

  const flag = await db.query.featureFlags.findFirst({
    where: eq(featureFlags.name, flagName),
  })
  return flag?.enabled ?? false
}
```

### Pattern 6: Admin Impersonation Banner

**What:** When an admin impersonates a user via `authClient.admin.impersonateUser()`, Better Auth sets `session.impersonatedBy` on the resulting session. The dashboard layout checks this field and renders a sticky banner ("You are viewing as user@example.com — [Stop Impersonating]"). The banner calls `authClient.admin.stopImpersonating()` to return to the admin session.

**When to use:** Any impersonation-capable admin panel. The banner is mandatory — impersonating without visible indication is a support risk.

**Trade-offs:** The impersonation session shares the same session cookie mechanism as regular sessions. Better Auth enforces that admins cannot impersonate other admins by default (configurable). Duration defaults to 1 hour. The banner must be rendered inside the dashboard layout, not the admin layout — impersonation navigates to the regular dashboard, not the admin panel.

```typescript
// web/app/(dashboard)/layout.tsx — add to existing layout
const session = await auth.api.getSession({ headers: await headers() })
const isImpersonating = !!session?.session.impersonatedBy

return (
  <DashboardShell>
    {isImpersonating && <ImpersonateBanner impersonatedUserId={session.user.id} />}
    {children}
  </DashboardShell>
)
```

---

## Data Flow

### Email Notification — Critical Alert (Immediate)

```
Relay server (cloud-mcp-gateway)
    | daemon connection drops
    | no reconnect within 5 minutes
    v
POST /api/cloud/notifications (service-to-service)
    | { deviceId, type: 'machine_offline', userId: resolved from deviceId }
    v
Next.js route handler
    | INSERT INTO notifications (userId, type, payload, createdAt)
    | check notification_preferences: channel='email', type='machine_offline'
    | frequency = 'immediate' (not daily_digest)?
    v
resend.emails.send() — critical-alert.tsx template
    | to: user.email, subject: "GSD: [Machine] has been offline for 5 minutes"
    v
Resend API → user's inbox
```

### Daily Digest Flow

```
Vercel Cron (0 8 * * *)
    v
GET /api/cron/daily-digest
    | Authorization: Bearer $CRON_SECRET
    v
Query: users WHERE email notification_preferences include 'daily_digest'
       AND no digest_jobs row for today
    v
For each user: collect notifications since last digest
    v
Chunk users into batches of 100
    v
For each batch: resend.emails.batch([...])
    | 100 emails per call, 2 calls/sec limit
    v
INSERT INTO digest_jobs (userId, sentAt, notificationCount, status)
```

### Admin User Management Flow

```
Admin navigates to /admin/users
    | (admin)/layout.tsx checks role === 'admin'
    v
GET /api/admin/users?page=1&search=query
    | route handler: authClient.admin.listUsers({ limit, offset, searchField })
    | OR direct Drizzle query for better filter control
    v
UserTable renders with TanStack Table
    v
Admin clicks "Ban User"
    --> POST /api/admin/users/[id] { action: 'ban', reason, expiresAt }
    --> authClient.admin.banUser({ userId, banReason, banExpiresIn })
    --> INSERT INTO audit_log (adminId, action, targetUserId, payload)  [existing table]
```

### Admin Impersonation Flow

```
Admin clicks "Impersonate" on user detail page
    v
POST /api/admin/impersonate { targetUserId }
    | authClient.admin.impersonateUser({ userId }, { headers })
    | Better Auth creates new session with impersonatedBy = adminId
    v
redirect('/dashboard')
    v
(dashboard)/layout.tsx
    | session.session.impersonatedBy is set
    | renders <ImpersonateBanner>
    v
Admin sees dashboard as target user
    v
Admin clicks "Stop Impersonating" in banner
    --> POST /api/admin/impersonate/stop
    --> authClient.admin.stopImpersonating()
    --> session restored to admin
    --> redirect('/admin/users/[id]')
```

### In-App Notification Push (SSE)

```
Server inserts notification row
    v
NotificationBell SSE connection (EventSource /api/cloud/notifications/sse)
    | 30s poll inside SSE keepalive
    | on next ping: re-queries unread count
    v
data: {"unreadCount": 3}\n\n
    v
NotificationBell re-renders with badge count
    v
User clicks bell → fetch /api/cloud/notifications?limit=20
    v
Popover shows notification list
    v
User clicks notification → PATCH /api/cloud/notifications/[id] {readAt: now}
```

---

## Integration Points

### New vs Modified — Complete Table

| File | Change | Purpose |
|------|--------|---------|
| `packages/db/src/schema/notifications.ts` | NEW | In-app notification store |
| `packages/db/src/schema/notification-preferences.ts` | NEW | Per-type/channel prefs (replaces boolean in user_preferences) |
| `packages/db/src/schema/digest-jobs.ts` | NEW | Cron idempotency tracking |
| `packages/db/src/schema/feature-flags.ts` | NEW | Feature flag definitions + user overrides |
| `packages/db/src/schema/index.ts` | MODIFY | Export new schemas |
| `web/lib/cloud-auth.ts` | MODIFY | Add `admin()` plugin to betterAuth() config |
| `web/lib/cloud-auth-client.ts` | MODIFY | Add `adminClient()` plugin to createAuthClient() |
| `web/app/(admin)/layout.tsx` | NEW | Admin role gate (server component) |
| `web/app/(admin)/page.tsx` | NEW | Metrics overview |
| `web/app/(admin)/users/page.tsx` | NEW | User management table |
| `web/app/(admin)/users/[id]/page.tsx` | NEW | User detail + actions |
| `web/app/(admin)/feature-flags/page.tsx` | NEW | Feature flag management |
| `web/app/(dashboard)/layout.tsx` | MODIFY | Check `session.impersonatedBy`, render ImpersonateBanner |
| `web/app/(dashboard)/settings/notifications/page.tsx` | NEW | Notification preferences UI |
| `web/app/api/cloud/notifications/route.ts` | NEW | GET list, PATCH mark-read |
| `web/app/api/cloud/notifications/sse/route.ts` | NEW | SSE unread count push |
| `web/app/api/cloud/notification-preferences/route.ts` | NEW | GET + PATCH prefs |
| `web/app/api/admin/users/route.ts` | NEW | Admin user list/search |
| `web/app/api/admin/users/[id]/route.ts` | NEW | Admin ban/role/sessions |
| `web/app/api/admin/impersonate/route.ts` | NEW | Start/stop impersonation |
| `web/app/api/admin/feature-flags/route.ts` | NEW | CRUD feature flags |
| `web/app/api/admin/metrics/route.ts` | NEW | Aggregate stats queries |
| `web/app/api/cron/daily-digest/route.ts` | NEW | Vercel Cron digest handler |
| `web/components/gsd/cloud/notification-bell.tsx` | NEW | Popover + SSE hook + badge |
| `web/components/gsd/cloud/notification-preferences.tsx` | NEW | Settings panel |
| `web/components/gsd/cloud/admin/user-table.tsx` | NEW | Paginated data table |
| `web/components/gsd/cloud/admin/user-detail-card.tsx` | NEW | Profile + actions |
| `web/components/gsd/cloud/admin/metrics-overview.tsx` | NEW | Stats cards |
| `web/components/gsd/cloud/admin/feature-flag-table.tsx` | NEW | Flag list with toggles |
| `web/components/gsd/cloud/admin/impersonate-banner.tsx` | NEW | "Viewing as X" sticky bar |
| `web/emails/notification-digest.tsx` | NEW | Daily digest React Email template |
| `web/emails/critical-alert.tsx` | NEW | Critical alert React Email template |
| `vercel.json` | MODIFY | Add cron schedule for daily-digest |
| `packages/db/src/schema/preferences.ts` | MODIFY | Keep `notificationsEnabled` boolean as global kill-switch; per-type prefs go in new table |

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Resend (existing) | `resend.emails.send()` for immediate alerts; `resend.emails.batch()` for digest (up to 100/call, 2 calls/sec) | Already installed. Use `Idempotency-Key` header for digest sends to prevent duplicates on retry. Attachments NOT supported in batch mode. |
| Neon Postgres (existing) | Neon HTTP driver (`@neondatabase/serverless`) handles all queries including cron batch queries | HTTP driver is correct for serverless — no persistent pool connections. Cron route is a serverless function just like any other route handler. |
| Stripe (existing) | Admin billing override reads from Stripe via existing webhook handler tables; billing overrides write to Stripe API via `stripe.subscriptions.update()` | Do not mirror Stripe state in your DB — read from Stripe directly in admin views. Write subscription changes back to Stripe, not to your DB (the webhook will update your DB). |
| Vercel Cron | HTTP GET to `/api/cron/daily-digest` with `Authorization: Bearer $CRON_SECRET` | Define in `vercel.json`. Cron runs only on production deployments. Secure with `CRON_SECRET` env var — reject any request without it. Design handler as idempotent (digest_jobs tracking). |
| Better Auth admin plugin | `auth.api.*` methods server-side; `authClient.admin.*` client-side | DB migration required before enabling the plugin (adds columns to user and session tables). Run `npx auth migrate` or `npx auth generate` after adding the plugin to the config. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Relay → notifications API | HTTP POST `/api/cloud/notifications` with `Authorization: Bearer $GSD_CLOUD_SERVICE_TOKEN` | Same service-to-service pattern as existing activity events. Resolve userId from deviceId server-side — never trust client-supplied userId. |
| Notifications API → SSE stream | In-process event emitter (optional) or 30s SSE poll | At v1 scale the 30s SSE keepalive poll is sufficient. For instant push: add a Node.js `EventEmitter` singleton in the route module and emit on each insert; SSE handlers subscribe. Reset on server restart. |
| Admin routes → Better Auth admin plugin | `authClient.admin.*` with `{ headers: await headers() }` | Admin plugin methods require the session headers to authenticate the requesting admin. Never call admin methods without passing headers. |
| Admin impersonate → Dashboard layout | Session cookie with `impersonatedBy` field set | The dashboard layout reads `session.session.impersonatedBy` at server render time. No client-side state needed for the banner. |
| Cron handler → Resend | `resend.emails.batch()` chunked at 100 | Sequential chunks with 500ms delay between calls respects the 2 req/sec rate limit. Track each run in `digest_jobs` for idempotency. |
| Feature flags → Server components | `isFeatureEnabled(flagName, userId)` from `web/lib/cloud/feature-flags.ts` | Evaluate in server components only — pass as props to client components. Never call from `useEffect` (causes flash of wrong state). |
| User preferences → Existing user_preferences table | `notificationsEnabled` boolean stays as global kill-switch | The new `notification_preferences` table handles per-type/channel granularity. The global boolean in `user_preferences` remains as the master opt-out. Check global boolean first in all notification dispatch paths. |

---

## Build Order

Hard dependencies determine implementation sequence. The admin plugin and DB schema changes block everything else.

### Step 1: DB Schema + Better Auth Admin Plugin Migration (blocks all other steps)

Add all new Drizzle tables, run migration, enable `admin()` plugin. Schema migrations must land before any feature code runs. The Better Auth admin plugin migration adds columns to existing `user` and `session` tables — this is not additive-only, it modifies existing tables.

Files: `packages/db/src/schema/notifications.ts`, `notification-preferences.ts`, `digest-jobs.ts`, `feature-flags.ts`, `index.ts` (MODIFY), `web/lib/cloud-auth.ts` (MODIFY + migrate).

### Step 2: In-App Notification Store (depends on Step 1)

Build the notifications API routes (GET, PATCH, SSE) and the NotificationBell component. This delivers the in-app notification bell with real-time SSE count push. Wire the relay to POST notifications on critical events.

Files: `api/cloud/notifications/`, `notification-bell.tsx`.

### Step 3: Notification Preferences UI (depends on Step 1 + Step 2)

Build the preferences API and settings page. Preferences control which notifications from Step 2 generate emails. The preference defaults (no rows = use defaults) mean this step can land after email sending starts — existing users get default behavior until they customize.

Files: `api/cloud/notification-preferences/`, `(dashboard)/settings/notifications/`, `notification-preferences.tsx`.

### Step 4: Daily Digest (depends on Step 1 + Step 3)

Build the cron handler, email templates, and add the `vercel.json` cron schedule. Depends on Step 3 to know which users want digest vs immediate. The critical alert email (immediate) can be built alongside Step 2 since it bypasses the frequency preference check.

Files: `api/cron/daily-digest/`, `emails/notification-digest.tsx`, `emails/critical-alert.tsx`, `vercel.json` (MODIFY).

### Step 5: Better Auth Admin Plugin UI (depends on Step 1, parallel with Steps 2-4)

Build the `(admin)` route group, admin API routes (users, metrics, impersonate), and admin UI components. This is independent of notifications (except that the admin can view notification counts in metrics). Can run in parallel with Steps 2-4.

Files: `(admin)/`, `api/admin/`, `components/gsd/cloud/admin/`, `(dashboard)/layout.tsx` (MODIFY for impersonate banner), `cloud-auth-client.ts` (MODIFY).

### Step 6: Feature Flags (depends on Step 1 + Step 5 admin panel)

Build the feature flags API and admin UI. Depends on Step 5 because the admin panel is where flags are managed. The server-side evaluation helper (`feature-flags.ts`) can be built any time after Step 1.

Files: `api/admin/feature-flags/`, `(admin)/feature-flags/`, `feature-flag-table.tsx`, `lib/cloud/feature-flags.ts`.

**Parallelizable pairs:**
- Steps 2+3+4 are the notification track — can run concurrently after Step 1
- Steps 5+6 are the admin track — can run concurrently after Step 1
- The two tracks (notification vs admin) are fully independent of each other

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-1K users | Current approach adequate — SSE 30s poll, cron digest, direct Drizzle queries for admin metrics |
| 1K-10K users | Add composite index on `notifications(userId, readAt, createdAt DESC)`; add `(userId, sentAt)` index on `digest_jobs`; consider caching admin metrics with 60s TTL in-memory; add Resend webhook for bounce tracking |
| 10K+ users | Separate digest sends to a proper job queue (PgBoss or graphile-worker); add Postgres `pg_notify` for real-time SSE push instead of 30s poll; read replica for admin metrics queries; cache feature flag evaluations per-user in-memory with 30s TTL |

### Scaling Priorities

1. **First bottleneck:** The daily digest cron at 10K+ users exceeds the 100-email/call Resend batch limit at 2 req/sec within a single serverless function timeout. Fix: break digest into a queue of jobs processed by multiple invocations (fan-out via multiple Vercel Cron tasks or a job queue).
2. **Second bottleneck:** The admin `/api/admin/metrics/route.ts` running COUNT aggregations on large tables. Fix: pre-compute metrics on a schedule and cache, or use Postgres materialized views.

---

## Anti-Patterns

### Anti-Pattern 1: Evaluating Feature Flags Client-Side

**What people do:** `useEffect(() => fetch('/api/feature-flags').then(setFlags), [])` — fetching flags after hydration.

**Why it's wrong:** Causes a flash of the wrong UI state (flagged-off feature renders, then disappears after the fetch). Also adds a network round-trip on every page load.

**Do this instead:** Evaluate flags in a server component using `isFeatureEnabled(flagName, userId)` and pass the result as a boolean prop to the client component. The flag decision is made before the HTML is sent.

### Anti-Pattern 2: Writing Notifications from the Browser Client

**What people do:** When a GSD command completes on the remote machine, the dashboard client POSTs to `/api/cloud/notifications` to create the notification.

**Why it's wrong:** Client-writeable notifications can be fabricated. A notification that "your billing was updated" or "admin action occurred" must only be written by server-side code after the action verifiably succeeded.

**Do this instead:** Write notifications only in server-side route handlers or relay event handlers after the triggering action commits to the DB. The relay POSTs to the notifications API via service-to-service (same pattern as existing activity events).

### Anti-Pattern 3: Calling Admin Plugin Methods Without Session Headers

**What people do:** `await auth.api.banUser({ userId })` in a server action or route handler without passing `{ headers: await headers() }`.

**Why it's wrong:** The admin plugin verifies the caller's session to confirm they have the `admin` role. Without headers, the call has no session context and will fail or (worse) succeed without role enforcement.

**Do this instead:** Always pass `{ headers: await headers() }` in server-side admin plugin calls. The layout server component's role check is a defense-in-depth gate, not a substitute for per-call authorization.

### Anti-Pattern 4: Daily Digest Without Idempotency Tracking

**What people do:** Cron handler runs, sends emails, no state recorded. On retry (Vercel Cron reruns on transient failure), all users receive duplicate digests.

**Why it's wrong:** Email duplication destroys user trust faster than any other transactional email bug. Vercel explicitly warns that cron jobs are best-effort and can retry.

**Do this instead:** INSERT a `digest_jobs` row per user per run at the start of digest send. On any retry, skip users with an existing row for today's date. Use an `Idempotency-Key` header in Resend batch calls for additional protection against duplicate sends at the API layer.

### Anti-Pattern 5: Per-User Notification Preference JSONB Blob

**What people do:** `user_preferences.notificationSettings: jsonb` storing `{ machine_offline: { email: true, frequency: 'immediate' }, task_completed: { email: false } }`.

**Why it's wrong:** No DB-level constraints; adding a new notification type requires writing migration logic to add the key to every existing row; querying "all users who want daily digest for machine_offline" requires `jsonb @> '...'` which is slower than an indexed column query and harder to read.

**Do this instead:** Normalized `notification_preferences` table with `(userId, notificationType, channel)` primary key. Row absent = use default. New notification types work for all users without a migration.

---

## Sources

- [Better Auth Admin Plugin Documentation](https://better-auth.com/docs/plugins/admin) — API methods, DB schema additions, impersonation config, role system verified directly from docs (MEDIUM confidence)
- [Resend Batch Email API Reference](https://resend.com/docs/api-reference/emails/send-batch-emails) — 100 emails/call limit, attachments not supported in batch, Idempotency-Key behavior verified from official docs (MEDIUM confidence)
- [Resend Rate Limit Documentation](https://resend.com/changelog/api-rate-limit) — 2 req/sec default verified (MEDIUM confidence)
- [Vercel Cron Jobs Documentation](https://vercel.com/docs/cron-jobs) — `vercel.json` syntax, `CRON_SECRET` pattern, idempotency requirement, production-only execution (MEDIUM confidence)
- [How to Build a SaaS Admin Panel: Features, Architecture, and Scope — Yaro Labs](https://yaro-labs.com/blog/saas-admin-panel) — Phase 1 admin panel scope, per-account feature flags, separate internal API principle (LOW confidence — web)
- [PostgreSQL-Based Job Queues Without Redis — DEV Community](https://dev.to/aws-builders/i-removed-redis-from-my-stack-and-used-postgresql-for-job-queues-instead-2lp5) — PgBoss + Postgres queue patterns (LOW confidence — web)
- [Next.js SSE in App Router — Damian Hodgkiss](https://damianhodgkiss.com/tutorials/real-time-updates-sse-nextjs) — ReadableStream + force-dynamic pattern, EventSource reconnection (LOW confidence — web)
- Existing `packages/db/src/schema/` — established Drizzle table definition patterns, naming conventions, and FK patterns followed directly
- Existing `packages/db/src/schema/preferences.ts` (Milestone 2) — `user_preferences.notificationsEnabled` boolean retained as global kill-switch
- Existing `web/lib/auth.ts` — `_token` query param SSE auth pattern (established, reuse for `/api/cloud/notifications/sse`)
- Existing `web/app/api/activity/route.ts` — service-to-service POST pattern with `GSD_CLOUD_SERVICE_TOKEN` for relay→notifications integration

---

*Architecture research for: GSD Cloud — email notifications, notification preferences, daily digest, admin panel*
*Researched: 2026-06-28*
