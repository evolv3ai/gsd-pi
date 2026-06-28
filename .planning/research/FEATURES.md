# Feature Research

**Domain:** Cloud SaaS dashboard — email notifications, notification preferences, daily digest, admin panel
**Researched:** 2026-06-28
**Confidence:** MEDIUM (cross-checked web sources and Better Auth docs; no single authoritative spec)

---

## Context: What Is Already Built

The following features exist and are NOT in scope for this milestone:

- Email/password auth with verification, password reset, session management
- Better Auth with 2FA, session management, IP allowlisting, admin plugin base
- Activity feed with SSE-backed notification bell, mark-read, event-type filtering
- Audit logging — append-only DB-backed viewer with filters
- Stripe billing (Free/Pro/Team) with Checkout, Customer Portal, webhooks
- RBAC team workspaces with invitations and per-machine sharing
- Device pairing, WebSocket relay, daemon, remote terminal, file browser

This research covers ONLY the new features for this milestone:
- Email notifications (critical alerts, notification preferences, daily digest)
- Admin panel (metrics, user management, impersonation, feature flags, billing overrides)

---

## Feature Landscape

### Table Stakes — Email Notifications

Features users expect in any SaaS product that sends email. Missing = product feels broken or untrustworthy.

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Transactional email delivery (welcome, verification, password reset) | Users expect account emails. These already exist but may need a real email provider (not nodemailer) behind them. | LOW | Resend API + react-email templates; no new DB schema needed |
| Critical alert emails (machine offline, auth from new IP, payment failure) | Users who are away from the dashboard must be notified of high-severity events. This is the primary ask of this milestone. | MEDIUM | Notification event system (already exists via activity feed), email delivery provider, per-user alert-opt-out preference |
| Unsubscribe / opt-out per email type | CAN-SPAM and GDPR require a one-click unsubscribe for marketing/digest. Critical security alerts (2FA, password reset) are exempt. | MEDIUM | notification_preferences table; one-click unsubscribe token link in each email; server-side opt-out endpoint |
| Email template consistency (brand, logo, footer) | Users correlate email quality with product quality. Mismatched templates erode trust. | LOW | Base react-email layout component shared across all templates |
| Delivery status visibility in audit log | Admins need to know "did that alert email actually send?" for support investigations. | LOW | Resend webhook → append to existing audit log table; new event type `email_sent` / `email_bounced` |

### Table Stakes — Notification Preferences

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Per-user per-category email opt-in/out | Users expect granular control ("I want machine-offline alerts but not daily digests"). Missing this leads to blanket unsubscribes. | MEDIUM | `notification_preferences` table: (userId, notificationType, channel, enabled); evaluated at send time |
| Preference UI in user settings | Users expect a settings page section where they manage notification choices. | MEDIUM | Preferences table + server action to save; shadcn form components already in stack |
| Instant vs. digest frequency choice per category | Standard SaaS UX: real-time for critical, digest for informational. | MEDIUM | Frequency column in preferences table (instant / daily / weekly / never); digest jobs read this |
| Default opt-in for critical alerts, opt-out for digest | Industry convention: security and billing events default on, marketing and digest default off. Users should not have to opt-in to learn their payment failed. | LOW | Seed default preference rows on user registration; or evaluate against hardcoded defaults if no row exists |

### Table Stakes — Daily Digest

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Daily summary email of activity events | Users who check GSD Cloud once per day expect a summary of what happened overnight. This is explicitly in the milestone brief. | MEDIUM | pg-boss cron job on Postgres (no Redis needed); Resend batch send; digest template |
| Digest respects user opt-in preference | Digest sent only to users who opted in. Non-opted users receive nothing. | LOW | Preference check before enqueue; cron job filters user list by digest=enabled |
| Digest aggregates by machine | Summary should group events by machine (e.g., "Machine laptop-home: 3 commands ran, 1 failed") not a flat list. | MEDIUM | Aggregation query across activity_events grouped by machine_id for the past 24h |
| Configurable send time (user timezone) | Users in Tokyo should not receive their "daily" digest at 3am local time. | MEDIUM | Store user timezone in profile; cron job fans out sends across timezone-bucketed batches or uses per-user scheduled send time |

### Table Stakes — Admin Panel

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Gated admin-only route (role check) | Admin panel must not be accessible to non-admins. Any SaaS platform has this. | LOW | Middleware role check on `/admin/*` routes; Better Auth admin plugin already provides role field |
| User list with search, filter, pagination | Support teams need to find users by email, ID, join date, subscription tier. | MEDIUM | TanStack Table or simple server-side filtered list; query the users table; Better Auth admin.listUsers API |
| User detail view (profile, sessions, machines, billing) | Admins investigating a support ticket need full context in one place. | MEDIUM | Aggregate from users, sessions, machines, stripe_customers tables; display-only |
| Subscription metrics overview (MRR, plan breakdown, new signups) | Business operators need top-level health KPIs at a glance. | MEDIUM | Query Stripe API or local Stripe data synced via webhooks; DAU/MAU requires activity event count queries |
| Ban / unban user | Support teams need to immediately suspend a bad actor. | LOW | Better Auth admin plugin has `banUser(userId, { reason, expiresAt })` and `unbanUser(userId)` built in |
| Revoke all sessions for a user | Security incident response: force logout across all devices. | LOW | Better Auth admin plugin has `revokeUserSessions(userId)` built in |

### Differentiators — Admin Panel

Features beyond minimum that distinguish the admin panel as genuinely useful.

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|--------------|
| User impersonation with audit trail | Support can debug user-reported issues by viewing the product as that user, eliminating "I can't reproduce" support tickets. Industry standard in B2B SaaS (Intercom, Notion, Linear all have this). | MEDIUM | Better Auth admin plugin `impersonateUser(userId)` + explicit impersonation reason field + write to audit log; visual banner in impersonated session ("Viewing as user@example.com — End session") |
| Feature flags panel (boolean per-user or per-plan) | Enables graduated rollouts without code deploys and lets support grant early access to a specific user. | HIGH | `feature_flags` table (name, enabled, targeting_rules JSONB); admin UI to toggle; evaluated in Server Components at request time; connect to Stripe plan via targeting rule `plan === 'pro'` |
| Billing overrides (apply credit, change plan, override trial) | Support needs to grant credits, fix billing errors, or extend trials without going to the Stripe dashboard for routine cases. | HIGH | Stripe API calls (stripe.subscriptions.update, stripe.customers.createBalanceTransaction); require impersonation audit log entry before allowing override; high-risk action requires confirmation dialog |
| System-wide announcement banner | Push a message visible to all users ("Maintenance tonight 11pm UTC") without a code deploy. | LOW | `system_announcements` table (message, active, expires_at); read in root layout via Server Component; admin toggle in panel |

### Anti-Features

Features that seem natural to build but create problems disproportionate to their value.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Email notifications for every in-app activity event | "Users want to know everything" | Email spam causes blanket unsubscribes. Users stop seeing critical alerts when buried in noise. | Strict category defaults: only critical + billing alerts default on. Informational events stay in-app only unless user explicitly opts in to digest. |
| Real-time email (send immediately on every event, no batching) | Seems responsive | Resend rate limits on free/starter plans; N emails per N events at scale is expensive and noisy. | Critical alerts = immediate (machine offline, payment failure, new device login). All other events = batch into daily digest. |
| Fully custom feature flag service (LaunchDarkly-style) | Seen in enterprise tools | Massive scope. Targeting rules engine, A/B test assignment, SDK client, analytics integration. Way beyond this milestone. | Simple boolean flags per user or per plan stored in Postgres. Evaluate at request time. No SDK. Extend only when targeting complexity demands it. |
| Admin access to remote terminals / filesystem | "Admins should see everything" | This is not a SaaS admin panel feature — it is a privileged escalation vulnerability. Admin impersonation already gives full context. | Impersonation is the correct tool. Raw admin terminal access is out of scope permanently. |
| Bulk email campaigns / marketing email from admin panel | Product teams sometimes want this | Email deliverability for transactional emails degrades when mixed with marketing sends. Different sending reputation required. | Use a dedicated marketing platform (Resend Broadcasts or Mailchimp) for campaigns. The admin panel should only trigger transactional sends. |
| Audit log deletion from admin panel | "Clean up old records" | Audit logs are the forensic record for compliance (SOC 2, GDPR data access logs). Deletable audit logs are a liability. | Audit logs are append-only forever. Expose read-only viewer in admin panel. If GDPR erasure is required, tombstone the user_id reference but keep the event. |

---

## Feature Dependencies

```
[Critical alert emails]
    └──requires──> [Notification event system (activity feed, already built)]
    └──requires──> [Resend email provider (new)]
    └──requires──> [react-email base template (new)]
    └──requires──> [notification_preferences table — alert opt-out check]

[Daily digest]
    └──requires──> [Resend email provider]
    └──requires──> [react-email digest template]
    └──requires──> [notification_preferences table — digest opt-in check]
    └──requires──> [pg-boss job queue on existing Postgres]
    └──requires──> [Activity event aggregation query]

[Notification preferences UI]
    └──requires──> [notification_preferences DB table]
    └──enhances──> [Critical alert emails (respects opt-out)]
    └──enhances──> [Daily digest (respects opt-in)]

[Unsubscribe one-click link]
    └──requires──> [notification_preferences table]
    └──requires──> [Signed unsubscribe token (HMAC or short-lived JWT)]

[Admin panel route]
    └──requires──> [Better Auth admin plugin role check (already wired)]
    └──requires──> [Admin-only middleware on /admin/* routes]

[User list + search]
    └──requires──> [Admin panel route]
    └──requires──> [Better Auth admin.listUsers API]

[User detail view]
    └──requires──> [User list]
    └──requires──> [Stripe customer lookup by user]

[User impersonation]
    └──requires──> [Admin panel route]
    └──requires──> [Better Auth admin.impersonateUser (already in plugin)]
    └──requires──> [Audit log entry on impersonation start/stop (new write)]
    └──requires──> [Impersonation reason field (new input in UI)]
    └──requires──> [Visual impersonation banner in app shell (new UI)]

[Feature flags panel]
    └──requires──> [Admin panel route]
    └──requires──> [feature_flags DB table (new)]
    └──requires──> [Flag evaluation in Server Components (new)]

[Billing overrides]
    └──requires──> [Admin panel route]
    └──requires──> [Stripe API calls (already have Stripe client)]
    └──requires──> [Audit log entry on billing override (new write)]
    └──enhances──> [User impersonation — should log which admin performed override]

[System announcement banner]
    └──requires──> [Admin panel route]
    └──requires──> [system_announcements DB table (new)]
    └──requires──> [Root layout reads active announcement (new Server Component fetch)]

[Ban/unban + revoke sessions]
    └──requires──> [Admin panel route]
    └──requires──> [Better Auth admin plugin (already has these methods)]
    └──requires──> [Audit log entry (new write)]
```

### Dependency Notes

- **All email features require Resend first.** Resend and react-email are the foundation. Wire them before building any specific email type. Do not build digest before testing single-send.
- **notification_preferences table is shared across all email features.** Schema it correctly from the start: (userId, notificationType ENUM, channel ENUM, frequency ENUM, enabled BOOLEAN, updatedAt). Add new notification types by extending the enum.
- **pg-boss for digest does NOT require Redis.** It runs on the existing Postgres database. No new infrastructure. Install `pg-boss`, start a worker process, schedule the nightly cron.
- **Better Auth admin plugin is already installed.** Impersonation, ban, revoke sessions, list users are already in the plugin. The work is: write audit log entries on each action, add reason-required fields, and build the UI.
- **Feature flags and billing overrides are HIGH complexity.** Do not combine both in the same phase. Feature flags require new DB schema, server-side evaluation logic, and admin UI. Billing overrides require Stripe API calls with safety guards.
- **Impersonation banner must be in the app shell.** It cannot be conditional on the page. Build it in the root layout, check for `isImpersonating` in session, render prominently.

---

## MVP Definition

### Launch With — v1 (this milestone)

Minimum viable delivery that satisfies the milestone brief without over-building.

**Email notifications:**
- [ ] **Resend + react-email integration** — Foundation. All other email features are blocked without this.
- [ ] **Critical alert emails: machine offline, new device login, payment failure** — The three highest-urgency events. These are the "I need to know right now" category.
- [ ] **notification_preferences table + default seeding** — Critical alerts default ON; digest defaults OFF. Evaluate at send time.
- [ ] **One-click unsubscribe (non-critical only)** — CAN-SPAM compliance. Critical alerts (auth, billing) exempt.
- [ ] **Daily digest email (opt-in)** — The explicit milestone requirement. pg-boss cron, 24h event aggregation, digest template.
- [ ] **Notification preferences UI in user settings** — Let users toggle categories and digest frequency.

**Admin panel:**
- [ ] **Admin-only route gate on /admin/** — Security prerequisite for everything below.
- [ ] **User list: search by email, filter by plan, pagination** — Support's first tool.
- [ ] **User detail view: profile + sessions + subscription status** — Context for support tickets.
- [ ] **Ban/unban + revoke all sessions** — Incident response. Built into Better Auth admin plugin already.
- [ ] **User impersonation with audit trail + reason field + visual banner** — The highest-value support tool. Better Auth plugin handles session; we add audit writing + UI.
- [ ] **Metrics overview: total users, plan breakdown, new signups (7d/30d), active machines** — Basic operational health. Query local DB; no external analytics needed at this scale.

### Add After Validation — v1.x

- [ ] **Feature flags panel** — Add once first flags are needed in the product. Build the DB table and evaluation logic first; add the admin UI when there are flags to manage.
- [ ] **System announcement banner** — Low effort once the infrastructure exists. Add when the team needs to communicate maintenance windows.
- [ ] **Billing overrides (credit, plan change, trial extension)** — High-value for support but HIGH risk. Add after impersonation is proven safe; guards and audit trail must be solid.
- [ ] **Delivery status tracking in audit log (Resend webhook)** — Useful for debugging bounces. Add after email is live and delivery issues surface.

### Future Consideration — v2+

- [ ] **Per-machine notification preferences** — Granular enough that only users with many machines would want this. Defer until requested.
- [ ] **Weekly digest option** — Current scope is daily. Add weekly if daily generates feedback that it's too frequent.
- [ ] **Admin metrics dashboard with charts (MRR trend, churn, DAU/MAU)** — Full analytics. Add only if Stripe webhooks syncing local data is already implemented; otherwise, use Stripe Dashboard.
- [ ] **Percentage-based feature flag rollout** — Extends boolean flags to gradual rollout. Requires hash-based user bucketing and more complex UI. Defer until product team needs it.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Resend + react-email integration | HIGH (blocker) | LOW | P1 |
| Critical alert emails (3 types) | HIGH | MEDIUM | P1 |
| notification_preferences table + defaults | HIGH | LOW | P1 |
| Preferences UI in user settings | HIGH | MEDIUM | P1 |
| Daily digest email | HIGH | MEDIUM | P1 |
| One-click unsubscribe | MEDIUM | LOW | P1 |
| Admin route gate (/admin/*) | HIGH (security) | LOW | P1 |
| User list (search, filter, paginate) | HIGH | MEDIUM | P1 |
| User detail view | HIGH | MEDIUM | P1 |
| Ban/unban + revoke sessions | MEDIUM | LOW | P1 |
| User impersonation + audit trail | HIGH | MEDIUM | P1 |
| Admin metrics overview | MEDIUM | MEDIUM | P1 |
| Feature flags panel | MEDIUM | HIGH | P2 |
| System announcement banner | MEDIUM | LOW | P2 |
| Billing overrides | MEDIUM | HIGH | P2 |
| Delivery status in audit log | LOW | LOW | P2 |
| Admin metrics with charts | MEDIUM | HIGH | P3 |
| Per-machine notification preferences | LOW | MEDIUM | P3 |
| Weekly digest option | LOW | LOW | P3 |
| Percentage-based feature flag rollout | LOW | HIGH | P3 |

**Priority key:** P1 = must have this milestone; P2 = next milestone; P3 = future

---

## Implementation Notes by Feature

### Email Provider: Resend + react-email

**Why Resend:** Native Next.js integration, react-email is their official template library, generous free tier (3000 emails/month), clean API. Resend does not mix deliverability concerns with marketing sends. Alternative (Postmark) is also good but less Next.js-native.

**react-email pattern:**
```
emails/
  _base-layout.tsx       ← shared header/footer/branding
  critical-alert.tsx     ← machine offline / new login / payment failure
  daily-digest.tsx       ← aggregated activity summary
  welcome.tsx            ← onboarding (already may exist)
```

Local preview: `npx react-email dev` — renders all templates in browser. Required step before any send.

**DO NOT dispatch bulk digest sends from an API Route or Server Action.** Serverless functions time out. Use pg-boss worker process.

### Notification Preferences Schema

```sql
CREATE TABLE notification_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,  -- 'machine_offline' | 'new_device_login' | 'payment_failure' | 'daily_digest'
  channel     TEXT NOT NULL DEFAULT 'email',  -- 'email' | 'in_app'
  frequency   TEXT NOT NULL DEFAULT 'instant', -- 'instant' | 'daily' | 'weekly' | 'never'
  enabled     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, type, channel)
);
```

Seed default rows on user registration. Query at send time: `WHERE user_id = $1 AND type = $2 AND channel = 'email' AND enabled = true`.

Critical alerts (machine_offline, new_device_login, payment_failure): default `enabled = true, frequency = 'instant'`.
Daily digest: default `enabled = false, frequency = 'daily'` — user must opt in.

### Daily Digest: pg-boss Pattern

pg-boss runs on existing Postgres. No Redis. No BullMQ. No separate infrastructure.

**Pattern:**
1. pg-boss worker process starts alongside the Next.js server (or as a separate process in Docker).
2. Schedule: `schedule('daily-digest-enqueue', '0 6 * * *', {})` — 6am UTC daily.
3. Handler: query all users where digest preference is enabled; enqueue one `digest-send` job per user.
4. `digest-send` handler: aggregate activity events for last 24h for that user's machines; render react-email template; call Resend.

**Batching:** fetch 1000 `digest-send` jobs at a time. Respect Resend rate limits (batch send API supports up to 100 per call; loop in groups of 100).

**Timezone bucketing:** If user timezone is stored, offset the cron to fire per-timezone-bucket (6am in each timezone = staggered UTC times). For MVP, fire once at 6am UTC and note the limitation.

### User Impersonation

Better Auth admin plugin already handles session creation. The implementation work:

1. **Reason field:** Admin UI must require a reason string before calling `authClient.admin.impersonateUser(userId)`. Store reason in the audit log.
2. **Audit log write:** On impersonation start: write `{ type: 'impersonation_start', admin_id, target_user_id, reason, expires_at }`. On stop: write `{ type: 'impersonation_stop', admin_id, target_user_id, duration_seconds }`.
3. **Visual banner:** Root layout reads `session.impersonatedBy` from Better Auth session metadata. If present, render a fixed top banner: "Viewing as user@example.com (impersonated by admin@example.com) — End session". Banner must be visually distinct (warning color).
4. **Session TTL:** Default 1hr in Better Auth config. Do not extend. Auto-expiry is a security property.
5. **Read-only enforcement:** Better Auth impersonation is NOT automatically read-only. For now: document that impersonation grants full user permissions. Billing overrides during impersonation are not blocked at the framework level — warn admins in UI. A future hardening pass can add write-blocking middleware.

### Feature Flags

Schema:
```sql
CREATE TABLE feature_flags (
  name        TEXT PRIMARY KEY,          -- 'new_dashboard_ui' | 'beta_command_palette'
  enabled     BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  targeting   JSONB DEFAULT '{}',        -- { "plans": ["pro","team"], "user_ids": ["abc123"] }
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT REFERENCES users(id)
);
```

Evaluation in Server Components:
```ts
async function isFeatureEnabled(flagName: string, userId: string, plan: string): Promise<boolean> {
  const flag = await db.query.feature_flags.findFirst({ where: eq(feature_flags.name, flagName) });
  if (!flag || !flag.enabled) return false;
  if (flag.targeting?.user_ids?.includes(userId)) return true;
  if (flag.targeting?.plans?.includes(plan)) return true;
  return flag.targeting && Object.keys(flag.targeting).length === 0; // no targeting = everyone
}
```

Cache with `unstable_cache` at 30-second TTL. Admin panel UI: table of flags, toggle switches, targeting JSON editor.

### Billing Overrides

**Scope:** Apply balance credit, change subscription plan, extend trial end date. All via Stripe API.

**Safety requirements:**
- Confirmation dialog with the admin re-typing the user email before any destructive override.
- Write audit log entry before calling Stripe API: `{ type: 'billing_override', admin_id, target_user_id, action, parameters }`.
- On Stripe API failure: surface the Stripe error in the UI. Do not swallow.
- On success: sync local subscription state (trigger the same webhook handler logic used for Stripe webhooks).

**Implementation note:** Do not call `stripe.subscriptions.update` from a Server Action without the audit log write completing first. Wrap in a transaction-like sequence: audit → Stripe → sync.

---

## Competitor Feature Analysis

| Feature | Intercom | Vercel (admin) | Linear | Our Approach |
|---------|----------|----------------|--------|--------------|
| Critical alert emails | Machine learning-based spam avoidance; multi-channel | Deployment failure, billing failure | Mention, assignment, comment | 3 types: machine offline, new login, payment failure; opt-out per type |
| Daily digest | Weekly digest (Intercom Messenger weekly digest) | No digest | Weekly update (opt-in) | Daily digest opt-in; 24h event aggregation per machine |
| Notification prefs | Category toggles + channel (email/push/in-app) per category | Minimal | Per-type toggle (email/in-app) | Per-type (enum) × channel (email/in-app) × frequency (instant/daily/never) |
| Admin user search | Full-text name/email/ID + custom attribute filter | Email only | Email + ID | Email search + plan filter + join date sort |
| Impersonation | "Login as user" — prominent in Intercom admin | No | No | Better Auth plugin + reason required + audit log + banner |
| Feature flags | Not admin panel (Intercom uses separate feature flag system) | Edge Config-based | No | DB-backed boolean flags + plan targeting; admin toggle UI |
| Billing overrides | Credit notes, subscription cancel, plan change via admin | No (Stripe Dashboard only) | No | Credit + plan change + trial extension; with audit trail |

---

## Sources

- [Better Auth Admin Plugin](https://better-auth.com/docs/plugins/admin) — MEDIUM confidence (official docs)
- [Notification Preference Center — SuprSend](https://www.suprsend.com/post/notification-preference-center) — LOW confidence (web)
- [User Impersonation Done Right — Pigment Engineering](https://engineering.pigment.com/2026/04/08/safe-user-impersonation/) — LOW confidence (web)
- [Safe User Impersonation Tool for SaaS — Yaro Labs](https://yaro-labs.com/blog/user-impersonation-tool-saas) — LOW confidence (web)
- [SaaS Feature Flags Implementation Guide](https://designrevision.com/blog/saas-feature-flags-guide) — LOW confidence (web)
- [Feature Flags in Next.js App Router](https://rollgate.io/blog/feature-flags-nextjs) — LOW confidence (web)
- [pg-boss Postgres Job Queue](https://github.com/timgit/pg-boss) — MEDIUM confidence (source)
- [Send emails with Next.js — Resend](https://resend.com/docs/send-with-nextjs) — MEDIUM confidence (official docs)
- [Impersonation Risks — Authress](https://authress.io/knowledge-base/academy/topics/user-impersonation-risks) — LOW confidence (web)
- [SaaS Metrics — Stripe](https://stripe.com/resources/more/essential-saas-metrics) — MEDIUM confidence (official)

---
*Feature research for: GSD Cloud — email notifications, notification preferences, daily digest, admin panel milestone*
*Researched: 2026-06-28*

---

## Historical: Prior Milestone Feature Research (2026-06-22)

The following is preserved from the activity feed / notifications / OAuth / onboarding milestone. All features listed below are now built.

### Table Stakes — Activity/Notifications/OAuth Milestone

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Activity feed / notification center | Users expect to know what happened (machine connected, command ran, teammate joined). Bell icon with unread badge is a universal SaaS convention. | MEDIUM | Bell icon + dropdown panel; newest-first list; unread count badge; mark-as-read per item and bulk; persist read state in DB per user. Build on existing WebSocket channel — no new transport needed. |
| Read/unread state per notification | Users get frustrated when all notifications appear read on second load, or never clear. | LOW | `read_at` timestamp column on notification rows; null = unread. Single DB update on open or explicit mark-read click. |
| Dismiss / clear notifications | Users need to manage notification noise over time. | LOW | Soft-delete (dismissed_at) or hard-delete; "Clear all" button. |
| Onboarding wizard for first-time users | Users connecting their first machine don't know the right sequence. | MEDIUM | 3–4 step modal wizard; progress indicator; skip allowed; resume if abandoned. |
| Skeleton loading states on machine cards | Without skeletons, dashboard flashes blank → data in a jarring way. | LOW | Shadcn Skeleton with pulse animation. |
| Empty state on dashboard (no machines) | A blank page with no context is confusing. | LOW | Illustration + "No machines connected yet" + CTA button. |
| Responsive machine card grid (mobile) | Mobile users expect a usable layout. | LOW | Tailwind responsive grid: 1 col mobile, 2 md, 3 lg. |
| OAuth social login (Google + GitHub) | GSD users are developers — they expect "Sign in with GitHub". | MEDIUM | Better Auth with Google and GitHub providers layered onto existing email/password. |

### Historical: Original Milestone Feature Research (2026-06-21)

All features listed below are now built.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| User authentication (email/password + session) | Every cloud platform requires account-based identity | LOW | Standard JWT/session; bcrypt; httpOnly cookies; email verification optional for MVP |
| Token-based device pairing | All remote tools use token registration | LOW | Generate token in UI; run gsd-agent --token; revocable per-device |
| Persistent outbound WebSocket daemon | Users expect daemon to work behind NAT | MEDIUM | Daemon connects outbound to relay; reconnect with exponential backoff |
| Machine status dashboard | Core value: see which machines are online | LOW | Online/offline/last-seen per machine |
| Remote GSD state read | Users connect to see project state from anywhere | MEDIUM | Daemon exposes GSD state over WS; relay proxies to cloud UI |
| Remote terminal / shell execution | Developers expect shell access | HIGH | PTY allocation; bidirectional I/O over WS; security-critical |
| Team workspace with opt-in machine sharing | Project-scoped sharing with RBAC | HIGH | Per-machine share; invite by email; owner/viewer roles |
| Subscription-based multi-machine + team | Stripe freemium; per-machine or per-seat | MEDIUM | Free=1 machine; Pro=unlimited machines; Team=Pro+workspaces |
