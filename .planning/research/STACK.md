# Stack Research

**Domain:** GSD Cloud — email notifications (critical alerts, preferences, digests) + admin panel (metrics, user management, impersonation, feature flags, billing overrides)
**Researched:** 2026-06-28
**Confidence:** MEDIUM

---

## Context: What This Milestone Adds

This file covers **only net-new stack additions** for this milestone. The existing validated stack is not re-litigated:

- Already present: Next.js 16, React 19, Better Auth 1.6.x, Drizzle ORM, Neon Postgres, Stripe, Resend (email verification), activity feed with SSE, audit logging infrastructure, shadcn/ui, Tailwind CSS 4, Radix UI, react-hook-form, zod

The two feature areas and their stack implications:

| Feature Area | Stack Impact |
|-------------|-------------|
| Email notifications (critical alerts, preferences, digests) | `react-email` 6.x (unified package) for templates; `resend.batch.send()` already in SDK for digests; Vercel Cron for scheduling; Drizzle schema for preferences |
| Admin panel (metrics, user management, impersonation, feature flags, billing overrides) | Better Auth `admin` plugin (config-only); shadcn/ui charts + Recharts for metrics; custom DB-driven feature flags table; Stripe Admin API calls for billing overrides |

**Net result: 2 new npm packages. Everything else is config, schema, and UI composition.**

---

## Recommended Stack

### New Packages Required

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| **react-email** | `^6.0.0` | Email template authoring — components + preview server + rendering | v6 (April 2026) unified ALL components and rendering into a single package. `@react-email/components` is now deprecated. Import components directly from `react-email`. Renders async via `render()` to email-safe HTML. React 19 compatible. The preview dev server (`npx react-email dev`) is included in the same package. Install once, use in prod and dev. |
| **recharts** | `^2.12.0` | Chart primitives for admin metrics dashboard | shadcn/ui chart components are built on Recharts and ship as copy-paste code. You add Recharts as a direct dep, then use `npx shadcn@latest add chart` to scaffold the themed wrappers. Do NOT use Tremor — it targets React 18 and its v4 rewrite is still unstable. Recharts + shadcn charts are the canonical React 19 / Next.js 16 admin dashboard pattern. |

### Already Present — Configuration or Schema Changes Only

| Capability | Package | Current Version | What Changes |
|------------|---------|-----------------|--------------|
| **Email delivery** | `resend` | present | Already installed for email verification. Use `resend.batch.send()` for digest (up to 100/call). Use `resend.emails.send()` with `scheduledAt` for timed alerts. Add `List-Unsubscribe` header for digest emails (required by Gmail/Yahoo bulk sender rules since Feb 2024). |
| **User impersonation** | `better-auth` | 1.6.x | Enable the built-in `admin` plugin via config — `betterAuth({ plugins: [admin()] })` on server + `adminClient()` on client. Run `npx auth migrate` once to add `role` and `banned` columns. No npm install. |
| **User management (CRUD, ban, sessions)** | `better-auth` | 1.6.x | Same admin plugin. Provides `authClient.admin.listUsers()`, `banUser()`, `impersonateUser()`, `revokeUserSessions()`. |
| **Feature flags** | Drizzle + Neon Postgres | present | Build a `feature_flags` table — no external service needed at this scale. Row per flag with user/org targeting JSON. Admin panel reads/writes via Server Actions. Migrate to LaunchDarkly or PostHog when you need percentage rollouts or A/B testing. |
| **Billing overrides** | `stripe` | present | Already installed. Admin billing override = calling Stripe API directly from a Server Action: `stripe.subscriptions.update()`, `stripe.customers.update()`, manual credit via `stripe.customerBalanceTransactions.create()`. No new package. |
| **Admin metrics data** | Drizzle + Neon Postgres | present | Query existing tables for MRR, DAU, daemon connections. Aggregate in Server Components or Route Handlers. No analytics pipeline needed — Postgres handles it at this scale. |
| **Admin UI components** | shadcn/ui (DataTable, Card, Badge, Select, etc.) | present | Admin panel pages compose existing shadcn primitives. DataTable (already scaffolded via shadcn) handles user list with sorting/pagination/search. |
| **Digest scheduling** | Vercel Cron | platform feature | Configure in `vercel.json` under `crons`. No npm install. Triggers HTTP GET to a Route Handler on schedule. |

---

## Architecture Patterns

### Email Notifications

**Template authoring (react-email 6.x):**

```typescript
// web/emails/daily-digest.tsx
import { Html, Head, Body, Container, Heading, Text, Button, Hr } from 'react-email'

export function DailyDigestEmail({ userName, events }: Props) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'sans-serif' }}>
        <Container>
          <Heading>Your GSD Daily Digest</Heading>
          {events.map(e => <Text key={e.id}>{e.summary}</Text>)}
          <Hr />
          <Button href={unsubscribeUrl}>Unsubscribe from digests</Button>
        </Container>
      </Body>
    </Html>
  )
}
```

**Rendering and sending:**

```typescript
// web/lib/email.server.ts
import { render } from 'react-email'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendDailyDigest(recipients: DigestRecipient[]) {
  // Build batch payload — up to 100 per call
  const emails = await Promise.all(
    recipients.map(async (r) => ({
      from: process.env.EMAIL_FROM!,
      to: r.email,
      subject: `GSD Daily Digest — ${format(new Date(), 'MMM d')}`,
      html: await render(<DailyDigestEmail userName={r.name} events={r.events} />),
      headers: {
        'List-Unsubscribe': `<${process.env.NEXT_PUBLIC_APP_URL}/api/unsubscribe?token=${r.unsubscribeToken}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }))
  )
  // Send in chunks of 100 (Resend batch limit)
  for (let i = 0; i < emails.length; i += 100) {
    await resend.batch.send(emails.slice(i, i + 100))
  }
}
```

**Digest scheduling (Vercel Cron):**

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/cron/daily-digest",
      "schedule": "0 9 * * *"
    }
  ]
}
```

```typescript
// web/app/api/cron/daily-digest/route.ts
import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  // Verify this is a Vercel cron request
  if (req.headers.get('user-agent') !== 'vercel-cron/1.0') {
    return new Response('Unauthorized', { status: 401 })
  }
  const recipients = await getDigestRecipients()  // query users with digest=true preference
  await sendDailyDigest(recipients)
  return Response.json({ sent: recipients.length })
}
```

**Critical alert path (synchronous, not digest):**

```typescript
// Called from daemon event handler — fire and forget, don't await in request path
export async function sendCriticalAlert(userId: string, alert: Alert) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM!,
    to: userEmail,
    subject: `[ALERT] ${alert.title}`,
    html: await render(<CriticalAlertEmail alert={alert} />),
  })
}
```

**Email preferences schema (Drizzle):**

```typescript
export const emailPreferences = pgTable('email_preferences', {
  userId: text('user_id').notNull().primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  criticalAlerts: boolean('critical_alerts').notNull().default(true),
  dailyDigest: boolean('daily_digest').notNull().default(false),
  weeklyDigest: boolean('weekly_digest').notNull().default(false),
  machineOfflineAlerts: boolean('machine_offline_alerts').notNull().default(true),
  taskCompletedAlerts: boolean('task_completed_alerts').notNull().default(false),
  unsubscribeToken: text('unsubscribe_token').notNull().$defaultFn(() => crypto.randomUUID()),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
```

### Admin Panel

**Better Auth admin plugin (config change only):**

```typescript
// web/lib/auth.ts — add admin plugin to existing Better Auth config
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'

export const auth = betterAuth({
  // ... existing config (database, emailAndPassword, etc.)
  plugins: [
    admin({
      defaultRole: 'user',
      adminUserIds: [process.env.ADMIN_USER_ID!],
      impersonationSessionDuration: 3600,  // 1 hour
    }),
  ],
})
```

```typescript
// web/lib/auth-client.ts — add adminClient to existing client
import { createAuthClient } from 'better-auth/client'
import { adminClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  // ... existing config
  plugins: [adminClient()],
})
```

Run `npx auth migrate` once — adds `role` and `banned`/`banReason`/`banExpires` columns to the users table.

**Admin route guard:**

```typescript
// web/app/admin/layout.tsx
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session || session.user.role !== 'admin') redirect('/dashboard')
  return <>{children}</>
}
```

**Feature flags schema (Drizzle — no external service):**

```typescript
export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull().unique(),         // e.g. 'multi_machine_ui'
  enabled: boolean('enabled').notNull().default(false),
  description: text('description'),
  targeting: jsonb('targeting'),               // { userIds: [], plans: ['pro'], percentage: 10 }
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Usage: cache flag lookups in server memory (Map) with 60s TTL
// Admin panel Server Action: db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, key))
```

**Metrics dashboard (shadcn charts + Recharts):**

```typescript
// web/app/admin/metrics/page.tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts'  // recharts direct
// OR use shadcn chart wrapper after: npx shadcn@latest add chart

// Queries: Server Component, no client-side fetch needed
const [mau, daemonConnections, mrr, newSignups] = await Promise.all([
  db.select({ count: count() }).from(sessions).where(gte(sessions.updatedAt, thirtyDaysAgo)),
  db.select({ count: count() }).from(daemonTokens).where(eq(daemonTokens.isActive, true)),
  getMRRFromStripe(),
  db.select({ count: count() }).from(user).where(gte(user.createdAt, thirtyDaysAgo)),
])
```

**Billing overrides (existing Stripe SDK):**

```typescript
// web/app/admin/users/[id]/billing/actions.ts
'use server'
import Stripe from 'stripe'
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function applyBillingCredit(customerId: string, amountCents: number, reason: string) {
  await stripe.customerBalanceTransactions.create(customerId, {
    amount: -amountCents,  // negative = credit
    currency: 'usd',
    description: `Admin override: ${reason}`,
  })
  // Write to audit log (existing infrastructure)
  await writeAuditLog({ action: 'billing_credit_applied', customerId, amountCents, reason })
}

export async function overrideSubscriptionPlan(subscriptionId: string, newPriceId: string, reason: string) {
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ price: newPriceId }],
    proration_behavior: 'none',
  })
  await writeAuditLog({ action: 'subscription_overridden', subscriptionId, newPriceId, reason })
}
```

---

## Installation

```bash
# Only two new npm packages for this entire milestone
cd web
pnpm add react-email@^6.0.0 recharts@^2.12.0

# No new dev dependencies — react-email 6 includes the preview server
```

```bash
# Run Better Auth migration to add admin columns
npx auth migrate

# New environment variables to add
ADMIN_USER_ID=                    # your user ID from the DB, grants first admin access
# RESEND_API_KEY and EMAIL_FROM already present from M1
```

```json
// vercel.json additions
{
  "crons": [
    { "path": "/api/cron/daily-digest", "schedule": "0 9 * * *" },
    { "path": "/api/cron/weekly-digest", "schedule": "0 9 * * 1" }
  ]
}
```

---

## New Drizzle Schema Additions

```typescript
// These tables are net-new — add to existing schema file

// Email notification preferences per user
export const emailPreferences = pgTable('email_preferences', {
  userId: text('user_id').notNull().primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  criticalAlerts: boolean('critical_alerts').notNull().default(true),
  dailyDigest: boolean('daily_digest').notNull().default(false),
  weeklyDigest: boolean('weekly_digest').notNull().default(false),
  machineOfflineAlerts: boolean('machine_offline_alerts').notNull().default(true),
  taskCompletedAlerts: boolean('task_completed_alerts').notNull().default(false),
  unsubscribeToken: text('unsubscribe_token').notNull().$defaultFn(() => crypto.randomUUID()),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Feature flags with targeting
export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull().unique(),
  enabled: boolean('enabled').notNull().default(false),
  description: text('description'),
  targeting: jsonb('targeting'),  // null = global; { userIds, plans, percentage }
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Note: Better Auth admin migration adds role, banned, banReason, banExpires to existing user table
// Run: npx auth migrate (do NOT manually alter the user table)
```

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| **react-email 6 (unified)** | `@react-email/components` (old split package) | Deprecated as of v6 (April 2026). The split package `@react-email/components` is no longer published/updated. Use the unified `react-email` package. |
| **Vercel Cron for digest scheduling** | Trigger.dev / Inngest / pg-boss | Vercel Cron is zero-infrastructure and free on Vercel Pro. Trigger.dev and Inngest are excellent but add a paid external dependency. pg-boss adds Node.js background worker complexity to a serverless app. At this scale (< 10K users), Vercel Cron is the right call. Revisit when digest processing exceeds 5-minute function timeout. |
| **DB-driven feature flags (custom)** | Unleash / LaunchDarkly / PostHog | External feature flag services make sense at > 50K users or when you need A/B testing with statistical significance. At this stage, a `feature_flags` Postgres table with JSON targeting gives 90% of the value at zero infrastructure cost. Migrate to PostHog (free up to 1M events) when you need experiment tracking. |
| **shadcn/ui charts + Recharts** | Tremor | Tremor's v4 rewrite (targeting React 19) is ongoing and not stable. shadcn/ui charts ship as copy-paste code that you own — no version drift, no Tremor breaking changes. Recharts is a battle-tested peer dep. |
| **Better Auth admin plugin** | Custom admin middleware | Better Auth's admin plugin gives impersonation, ban, role management, and session revocation with a single config line. Building it custom takes 2-3 days and introduces subtle security bugs. The plugin is actively maintained alongside the auth core. |
| **resend.batch.send() for digests** | Separate scheduled email service (Mailchimp, etc.) | Resend is already in the stack. batch.send() handles up to 100/call and can be chunked. No reason to add a marketing email service for operational digests. |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Novu / Knock / MagicBell** (notification SaaS) | Per-MAU pricing, external dependency, and you already have Resend + an activity feed. These are excellent but premature — build the email preferences + Resend path first, migrate only if notification complexity explodes. | Custom `email_preferences` table + Resend |
| **`@react-email/components`** (old package) | Deprecated. Components are now in the unified `react-email` package as of v6. Installing the old package pulls in stale, unmaintained code. | `react-email` |
| **Unleash / Flagsmith self-hosted** | Requires running a separate Node.js + Postgres service. Net-new infrastructure for a feature you can solve with a 4-column DB table. | Custom `feature_flags` Drizzle table |
| **Separate analytics DB (ClickHouse, Redshift)** | Admin metrics at this scale (< 10K users) are fast enough with indexed Postgres queries. Introducing a warehouse is 3+ days of infrastructure work with no payoff yet. | Drizzle queries against existing Neon tables |
| **Stripe Billing Portal for admin overrides** | The Stripe Customer Portal is for end users to self-manage. Admin overrides require direct Stripe API calls (subscriptions.update, customerBalanceTransactions.create) with audit logging — the portal cannot be used for admin-side overrides. | Direct Stripe API from Server Actions |
| **A cron library (node-cron, cron-scheduler)** | Vercel handles scheduling via `vercel.json`. Running a timer inside a serverless function is unreliable and will be killed between requests. | Vercel Cron in vercel.json |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `react-email@6.x` | React 19, Node.js >=18, Next.js 15/16 | v6 (April 2026) fully supports React 19 async rendering. Import everything from `react-email`. |
| `recharts@2.12.x` | React 18+ (no explicit React 19 peer yet) | Works with React 19 — recharts uses React internals conservatively. shadcn/ui's chart wrappers handle any shim needed. Check before upgrading to recharts 3.x when it releases. |
| `better-auth admin plugin` | better-auth 1.6.x, Next.js 15/16 | Built into the existing better-auth package — no separate install. Plugin is stable as of 1.6.x. |
| `resend.batch.send()` | resend SDK (already installed) | Batch API available since resend v2. No version change needed. `scheduledAt` NOT supported in batch — use individual `emails.send()` with `scheduledAt` for timed single emails. |
| Vercel Cron | Vercel Pro (minimum for > 2 crons / < daily frequency) | Hobby plan: max 2 cron jobs, once per day. Pro plan: more jobs, up to 1/minute. Function timeout: Hobby 10s, Pro 300s. Daily digest sending must complete within 300s — chunk batches accordingly. |

---

## Sources

- [react-email changelog](https://react.email/docs/changelog) — v6.0.0 (April 2026) unifies all components into `react-email`, deprecates `@react-email/components` (MEDIUM confidence — official docs)
- [Resend batch emails API](https://resend.com/docs/api-reference/emails/send-batch-emails) — 100/call limit, `scheduledAt` not supported in batch, SDK method `resend.batch.send()` confirmed (MEDIUM confidence — official docs)
- [Resend Topics — unsubscribe management](https://resend.com/blog/unsubscribe-topics) — per-topic subscription preferences, global Subscribed status overrides topics (MEDIUM confidence — official blog)
- [Better Auth admin plugin docs](https://better-auth.com/docs/plugins/admin) — impersonation, ban, role management, `impersonationSessionDuration` config, `npx auth migrate` for schema changes (MEDIUM confidence — official docs)
- [Vercel Cron Jobs docs](https://vercel.com/docs/cron-jobs) — vercel.json configuration, UTC-only, plan limits, function timeout limits confirmed (MEDIUM confidence — official docs, updated 2026-06-16)
- [shadcn/ui charts](https://v3.shadcn.com/docs/components/chart) — Recharts-backed, 53+ chart components, React 19 + Next.js 15/16 compatibility notes confirmed (MEDIUM confidence — official docs)
- [Next.js background jobs comparison — HashBuilds](https://www.hashbuilds.com/articles/next-js-background-jobs-inngest-vs-trigger-dev-vs-vercel-cron) — Vercel Cron vs Trigger.dev vs Inngest tradeoffs (LOW confidence — web)
- [Feature flags comparison — GrowthBook blog](https://www.growthbook.io/blog/best-open-source-feature-flagging-tools-compared) — custom DB flags vs Unleash/Flagsmith/LaunchDarkly decision factors (LOW confidence — web)
- [Better Auth impersonation Next.js discussion](https://github.com/better-auth/better-auth/discussions/2152) — confirmed impersonateUser + stopImpersonating pattern in Next.js (LOW confidence — community discussion)
- [Render.com: Next.js background jobs + PostgreSQL](https://render.com/articles/nextjs-background-jobs-postgresql-production) — pg-boss vs Trigger.dev vs Vercel Cron comparison, pg-boss SKIP LOCKED explained (LOW confidence — web)

---

*Stack research for: GSD Cloud Milestone 3 — email notifications (critical alerts, preferences, digests) + admin panel (metrics, user management, impersonation, feature flags, billing overrides)*
*Researched: 2026-06-28*
