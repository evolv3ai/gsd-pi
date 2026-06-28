# Project Research Summary

**Project:** GSD Cloud Milestone 3 — Email Notifications & Admin Panel
**Domain:** Cloud SaaS dashboard with email notification system, admin management, and feature flags
**Researched:** 2026-06-28
**Confidence:** MEDIUM-HIGH

---

## Executive Summary

This milestone adds email notification infrastructure (critical alerts, preferences, daily digest) and admin panel capabilities (user management, impersonation, feature flags, billing overrides) to the existing GSD Cloud Next.js 16 + React 19 platform. The research validates that the recommended approach uses minimal new infrastructure: two npm packages (react-email v6, recharts), Resend's existing batch API, Vercel Cron for scheduling, and Better Auth's built-in admin plugin for role management and impersonation.

The approach is **proven and standard** for SaaS platforms at this scale (<10K users), avoiding premature external dependencies (Novu, LaunchDarkly, separate job queues). However, the implementation surface is large — 12 pitfalls identified, primarily around webhook handling, digest performance, email compliance (RFC 8058 + GDPR), and audit logging for sensitive admin actions. The roadmap should sequence work to lock in core infrastructure (schema, Better Auth admin plugin) before parallelizing notification and admin tracks.

Key risks include: (1) Resend webhook deduplication and bounce handling requiring explicit user-side suppression lists, (2) Daily digest hitting Neon connection pool limits at scale, (3) Admin impersonation audit trails missing from default implementations, and (4) GDPR classification of digest emails as marketing (not transactional) requiring explicit opt-in for EU users. All are mitigable with proper sequencing and schema choices upfront.

---

## Key Findings

### Recommended Stack

**Net-new packages:** Only 2 npm installs required.

| Package | Purpose | Rationale |
|---------|---------|-----------|
| **react-email 6.x** | Email template authoring & rendering | Unified package as of April 2026; React 19 compatible; `render()` outputs email-safe HTML; includes preview dev server |
| **recharts 2.12.x** | Admin dashboard metrics charts | Works with React 19; shadcn/ui chart components are Recharts-backed and ship as copy-paste code; DO NOT use Tremor (React 18 only, v4 unstable) |

**Existing stack — configuration & schema only:**
- **Resend** (already installed) — Use `resend.batch.send()` for digests (up to 100/call), `resend.emails.send()` with `scheduledAt` for timed alerts; CRITICAL: implement your own `email_preferences` suppression table (Resend does NOT auto-suppress transactional sends)
- **Better Auth 1.6.x** — Admin plugin adds `role` + `banned` + `impersonatedBy` fields via `npx auth migrate`; provides `impersonateUser()`, `banUser()`, `revokeUserSessions()` out-of-box
- **Neon Postgres (serverless)** — `pg_cron` NOT supported; use Vercel Cron or GitHub Actions as external scheduler
- **Vercel Cron** — Defined in `vercel.json`; triggers `/api/cron/daily-digest` with `Authorization: Bearer $CRON_SECRET` header
- **Drizzle ORM** — 4 new tables: `email_preferences`, `notifications`, `digest_jobs`, `feature_flags` (+ `user_feature_overrides`)

**Architectural patterns:** All patterns are established production SaaS conventions (Intercom, Linear, Vercel all use these approaches).

### Expected Features

**Table stakes (must ship):**
- Resend + react-email integration (foundation for all email)
- Critical alert emails: machine offline, new device login, payment failure
- Per-type opt-out preferences with defaults (critical=on, digest=off)
- One-click unsubscribe (RFC 8058 + CAN-SPAM compliance)
- Daily digest (opt-in) with 24h event aggregation
- Admin role gate on `/admin/*` routes
- User list with search/filter/pagination
- User detail view (profile, sessions, billing)
- Ban/unban + revoke all sessions (Better Auth plugin built-in)
- User impersonation with audit trail + reason field + visual banner

**Should have (competitive, v1 deliverable):**
- Admin metrics overview (user count, active machines, new signups)
- Feature flags table (simple boolean toggles + per-user overrides)
- System-wide announcement banner

**Defer to v2+:**
- Billing overrides (apply credit, change plan, trial extension)
- Admin metrics charts/dashboard
- Percentage-based feature flag rollout
- Weekly digest option
- Per-machine notification preferences

### Architecture Approach

The system is **cleanly modular with clear separation of concerns.** Email notifications (Resend + react-email) run through Vercel Cron to Neon to the browser via SSE for real-time badge updates. Admin actions (ban, impersonate, billing) go through Better Auth's plugin methods + server-side authorization checks + audit log writes. Feature flags evaluate server-side in route handlers and are passed as props to client components (never fetch client-side).

The critical insight: **notifications and admin are independent tracks** that can be parallelized after shared infrastructure (Step 1: DB schema + Better Auth migration) lands. Notification preferences initialize from REST on page load, then WebSocket delta-updates the badge. Impersonation sessions have short TTL (1 hour default) and require explicit "End" button. Digest jobs use `p-limit` concurrency to respect Neon's pooled connection limits.

**Major components:**
1. **Database schema** — `email_preferences` (userId, notificationType, channel, frequency), `notifications` (in-app store), `digest_jobs` (cron tracking), `feature_flags` + `user_feature_overrides`
2. **Email delivery** — Resend + react-email templates (critical-alert, digest); render on demand; batch via `resend.emails.batch()`
3. **Notification preferences API** — REST endpoint for UI to read/write per-type/channel settings
4. **Daily digest cron** — Vercel Cron → `/api/cron/daily-digest` → Neon query (single GROUP BY, not per-user loops) → Resend batch
5. **Better Auth admin plugin** — Adds role/ban/impersonatedBy; exposes `admin.listUsers()`, `banUser()`, `impersonateUser()`
6. **Admin panel** — Route group `(admin)` with layout-level role gate; pages for users, metrics, feature flags
7. **Feature flag evaluation** — Server-side helper queries DB once, caches 30s, passes result as prop to client
8. **In-app notification bell** — SSE stream `/api/cloud/notifications/sse` for real-time badge push; REST for full list fetch

### Critical Pitfalls

1. **Resend opt-out not automatic** — Resend does NOT suppress opted-out users for transactional sends (unlike marketing platforms). You must maintain `email_preferences` table and query it before every send. Bounce/complaint webhooks must update suppression flags immediately.

2. **RFC 8058 one-click unsubscribe required** — Gmail/Yahoo block bulk sends (>5K/day) without `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header + a POST endpoint. Missing this is now a Gmail/Yahoo hard requirement (Feb 2024+); absence causes spam folder or rejection. Implement from day one.

3. **Webhook deduplication on `svix-id`** — Resend webhooks use at-least-once delivery. No deduplication in your handler = duplicate bounce events update suppression twice, corrupt metrics, or violate rate limits. Store `svix-id` in `processed_webhook_events` table with UNIQUE constraint.

4. **Impersonation audit trail missing from Better Auth default** — Better Auth's `impersonateUser()` creates a session with `impersonatedBy` set, but does NOT write to an audit log. Without explicit audit logging, SOC 2 and GDPR compliance fail: logs show the victim's ID as the actor, not the admin's. You must write `impersonation_audit_log` entries on every start/stop.

5. **Digest at scale hits Neon connection pool limits** — Naive per-user query loop (one DB call per user) with `Promise.all()` can fire 10K simultaneous connections for 10K users, exhausting Neon's pooled connections and timing out the app. Use: single broad GROUP BY query, batch processing with `p-limit` concurrency ≤10, and always use the pooled URL (`-pooler` hostname).

6. **GDPR: Daily digest is marketing email, not transactional** — Digest defaults to ON = violation for EU users. Even if enabled at signup, "we may send you emails" is insufficient consent. Digest must be opt-in with explicit checkbox + timestamp, separate from transactional (password reset, billing receipt). Failure = GDPR complaint + forced user disabling + reputational damage.

---

## Implications for Roadmap

Based on research, the optimal phase structure has **two independent parallel tracks** (notifications & admin) sharing a **common DB/auth foundation**, with a **critical sequencing rule**: database schema and Better Auth admin plugin migration block everything.

### Phase 0: Foundation (Blocking All Other Phases)
**Rationale:** All email, admin, and flag features depend on DB schema and Better Auth configuration. Migrations must land before any feature code.

**Delivers:**
- Drizzle migrations for 4 new tables: `email_preferences`, `notifications`, `digest_jobs`, `feature_flags`, `user_feature_overrides`
- Better Auth admin plugin enabled via `betterAuth({ plugins: [admin()] })`
- `npx auth migrate` run to add `role`, `banned`, `banReason`, `banExpires` to user table, `impersonatedBy` to session table
- Environment variables set: `ADMIN_USER_ID` (first admin), `CRON_SECRET`

**Avoids:** None of the email, admin, or flag work starts until migrations land.

**Parallelizable after:** Notifications track (Phase 1A) and Admin track (Phase 1B) can both start immediately after Phase 0 completes.

---

### Phase 1A: Notification Foundation (Parallel with 1B)
**Rationale:** Email delivery infrastructure is the foundation for all notification features (critical alerts, digest, preferences). Sequence: Resend wire-up → core notification APIs → preferences → then digest/alerts build on top.

**Delivers:**
- Resend + react-email 6 npm packages installed
- Email templates: `web/emails/critical-alert.tsx`, `web/emails/notification-digest.tsx`
- Notification preferences table fully populated with schema
- `/api/cloud/notification-preferences/route.ts` (GET + PATCH)
- `/api/cloud/notifications/route.ts` (GET list, PATCH mark-read, DELETE dismiss)
- `/api/cloud/notifications/sse/route.ts` (SSE real-time badge push)
- `web/components/gsd/cloud/notification-bell.tsx` (bell + popover + SSE hook)
- `web/components/gsd/cloud/notification-preferences.tsx` (settings UI)
- `web/app/(dashboard)/settings/notifications/page.tsx` (preferences page)

**Features implemented:**
- Notification preferences UI (per-type/per-channel toggles)
- In-app notification bell with unread badge + real-time SSE updates
- One-click unsubscribe token generation + endpoint (RFC 8058 + CAN-SPAM)
- Critical alert emails (template only, not sent yet — awaits daemon relay hook)

**Avoids:** Pitfall #25 (Resend opt-out), #26 (RFC 8058), by implementing suppression table + unsubscribe header from day one.

**Needs research during planning:** Webhook deduplication strategy (Pitfall #27), Resend error handling.

---

### Phase 1B: Admin Panel Foundation (Parallel with 1A)
**Rationale:** Admin user management and impersonation require Better Auth plugin + route guard + audit logging. Sequence: role gate → user list → user detail → impersonate.

**Delivers:**
- `/admin` route group with layout-level role check (`(admin)/layout.tsx`)
- `/admin/page.tsx` (metrics overview: user count, active machines, new signups, MRR)
- `/api/admin/users/route.ts` (list/search via Better Auth admin API)
- `/admin/users/page.tsx` (paginated user table with search/filter/sort)
- `/admin/users/[id]/page.tsx` (user detail: profile, sessions, ban/unban, impersonate)
- `/api/admin/users/[id]/route.ts` (ban, unban, revoke sessions)
- `/api/admin/impersonate/route.ts` (start/stop impersonation)
- `web/components/gsd/cloud/admin/impersonate-banner.tsx` (sticky "Viewing as X" banner)
- `impersonation_audit_log` table (immutable, security-scoped)
- Impersonation audit logging on every start/stop (including admin_id + target_id + reason)

**Features implemented:**
- Admin-only route protection
- User list with search/filter/pagination
- Ban/unban + revoke all sessions
- User impersonation with audit trail + reason field + visual banner

**Avoids:** Pitfall #30 (audit trail), #31 (server-side role check), #33 (short TTL + explicit close), by building audit logging + strong auth checks into the feature from day one.

**Needs research during planning:** Better Auth admin plugin API specifics (impersonation session TTL, permission model).

---

### Phase 2: Daily Digest (Depends on 1A + Phase 0)
**Rationale:** Digest sends depend on email infrastructure (1A) and notification preferences initialized. External scheduler + batch sending pattern is critical to avoid performance pitfalls.

**Delivers:**
- Vercel Cron configuration in `vercel.json`
- `/api/cron/daily-digest/route.ts` (handler)
- `digest_jobs` table for idempotency tracking
- Digest template rendering + Resend batch send
- Batching + concurrency limiting (p-limit) to respect Neon pool
- Single broad GROUP BY query to aggregate events (not per-user loops)

**Features implemented:**
- Daily digest email sent at 8 AM UTC to opted-in users
- Digest aggregates activity by machine over past 24h
- Idempotent handling (duplicate cron runs don't send duplicate emails)

**Avoids:** Pitfall #28 (pg_cron not available), #29 (connection pool exhaustion), by using external scheduler + single batched query.

**Needs research during planning:** Vercel Cron rate limits, Neon pooler hostname configuration.

---

### Phase 3: Critical Alert Emails (Depends on 1A)
**Rationale:** Critical alerts (machine offline, new login, payment failure) are simpler than digest — one-off sends, no scheduling needed. Sequence after core notification infrastructure is stable.

**Delivers:**
- Alert routing from daemon/relay (POST `/api/cloud/notifications` service-to-service)
- Preferences check before sending (critical alerts default ON, respects opt-out)
- Resend bounce/complaint webhook handler with deduplication

**Features implemented:**
- Critical alerts for machine offline (5min timeout), new device login, payment failure
- Bounce webhook updates `email_preferences` suppression immediately
- Complaint webhook marks user as globally opted out

**Avoids:** Pitfall #25 (suppression), #27 (webhook duplication), by using UNIQUE constraint on `svix-id` + bounce handler.

**Needs research during planning:** Daemon relay API contract, alert event schema.

---

### Phase 4: Feature Flags (Depends on Phase 0 + 1B)
**Rationale:** Feature flags require both database schema (Phase 0) and admin UI (Phase 1B admin panel). Implementation is straightforward once admin infrastructure exists.

**Delivers:**
- `/api/admin/feature-flags/route.ts` (CRUD)
- `/admin/feature-flags/page.tsx` (flag list + toggle UI)
- `web/lib/cloud/feature-flags.ts` (server-side evaluation helper)
- Per-user override resolution (user override > global flag value)
- In-memory flag cache with 30s TTL

**Features implemented:**
- Boolean feature flags with optional per-user overrides
- Server-side evaluation (no client-side fetches)
- Admin UI to toggle flags globally and per-user

**Avoids:** Pitfall #34 (flag reuse), #35 (fail-open), by building flag registry + safe-default evaluation from day one.

**Needs research during planning:** Flag evaluation performance at scale, cache invalidation strategy.

---

### Phase 5: Advanced Admin Features (Depends on 1B + 4)
**Rationale:** Billing overrides and system announcements are lower-priority support tools. Sequence after core admin panel is proven safe.

**Delivers:**
- `/api/admin/billing-overrides/route.ts` (apply credit, change plan, extend trial)
- `admin_billing_overrides` table (audit trail with required reason + expiry)
- `/admin/feature-flags/[id]/page.tsx` (advanced flag targeting rules)
- `/api/admin/announcements/route.ts` (system-wide banner CRUD)
- System announcement banner in root layout

**Features implemented:**
- Billing overrides with immutable audit log
- Billing override expires-at enforcement
- System announcement with active/inactive toggle

**Avoids:** Pitfall #38 (billing audit), by tying overrides to audit table from inception.

**Needs research during planning:** Stripe API integration patterns, announcement lifecycle.

---

### Phase Ordering Rationale

**Why Phase 0 first:** DB schema and Better Auth migration are blocking dependencies; all downstream work depends on these landing.

**Why 1A + 1B parallel:** Notifications and admin are completely independent. Email infrastructure (1A) does not need admin APIs; admin does not need email. Parallelizing saves one milestone cycle.

**Why 2 after 1A:** Digest depends on notification preferences (1A) being fully wired. The digest cron job reads `email_preferences` to determine who gets a digest; the table must exist.

**Why 3 before 4:** Critical alerts (3) are simpler than feature flags (4). Alerts are event-driven sends; flags require evaluation in route handlers. Shipping alerts gives quick momentum; feature flags can land after.

**Why 4 depends on 1B:** Feature flag admin UI (Phase 4) requires the admin panel's foundational pages (1B) already built. The flag management UI is a new section of the admin area, not standalone.

**Why 5 last:** Billing overrides are high-risk and need the admin panel (1B) proven safe first. System announcements are low-effort but also low-priority.

---

### Research Flags

**Phases likely needing deeper research during planning:**

- **Phase 2 (Daily Digest):** Neon connection pooling specifics (pooler hostname, pool size limits), Vercel Cron rate limits at scale, Resend batch API retry behavior. Research task: verify Neon pooler endpoints, test digest with 1K+ users, confirm Vercel Cron secret handling.

- **Phase 3 (Critical Alerts):** Daemon relay → cloud API contract (how are alerts triggered, what event schema). Research task: collaborate with daemon team on alert event types and routing payload.

- **Phase 5 (Billing Overrides):** Stripe API calls from server actions, prorating behavior, idempotency. Research task: verify Stripe API for plan changes + credit application, test idempotency headers.

**Phases with established patterns (skip deep research):**

- **Phase 0 (Foundation):** Drizzle migrations, Better Auth admin plugin, standard SQL schema. Patterns are well-documented; follow STACK.md recommendations directly.

- **Phase 1A (Notifications):** Resend + react-email are officially documented. SSE pattern is standard for real-time browser updates. Follow ARCHITECTURE.md patterns directly.

- **Phase 1B (Admin):** Better Auth admin plugin has official docs. Role-based access control is a standard SaaS pattern. Follow ARCHITECTURE.md patterns directly.

- **Phase 4 (Feature Flags):** Feature flag evaluation is a standard pattern. No external service needed; DB-backed flags are battle-tested at this scale (<10K users).

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | **HIGH** | Resend, react-email, Better Auth, Vercel Cron all have official docs; choices verified against current versions (Q2 2026) |
| Features | **MEDIUM** | Feature list sourced from milestone brief + standard SaaS expectations; email notifications classification (transactional vs. marketing) relies on GDPR interpretation (community consensus, not official legal advice) |
| Architecture | **HIGH** | All patterns derived from Better Auth official docs, Resend batch API docs, production SaaS examples (Intercom, Linear); data flow and component responsibilities well-established |
| Pitfalls | **MEDIUM-HIGH** | 12 pitfalls sourced from production post-mortems (Stripe webhook races, WebSocket backpressure), official CVEs (marimo, LXD), RFC 8058 (Feb 2024 Gmail/Yahoo requirement), Better Auth known gaps (issue #7806 email case mismatch); some pitfalls inferred from analogous systems (CloudFlare, AWS SSM) |

**Overall confidence:** **MEDIUM-HIGH**

### Gaps to Address

1. **Daemon relay alert event schema** — Critical alerts phase (3) depends on relay posting to `/api/cloud/notifications`, but the exact event payload schema is not documented in this research. *Mitigation:* Phase 3 planning must include collaboration with daemon team to finalize alert event contract. Non-blocking; other phases proceed in parallel.

2. **User timezone handling for digest send time** — STACK.md suggests digest respects user timezone but does not specify implementation. Current design sends digest once at UTC time. *Mitigation:* Document as Phase 2 limitation ("UTC-only for MVP; add per-timezone bucketing in v1.1 if users request"). No schema change needed.

3. **GDPR compliance verification** — GDPR email classification (digest as marketing, not transactional) is inferred from regulation interpretation, not verified with legal counsel. *Mitigation:* Phase 1A planning should include compliance review before digest UI launches. Add GDPR consent capture to schema upfront to unblock Phase 1A (email_preferences is ready; just needs UX for explicit opt-in).

4. **Billing overrides vs. Stripe sync strategy** — STACK.md mentions billing overrides call Stripe API directly but doesn't specify webhook sync strategy. Risk: admin overrides and Stripe events can race. *Mitigation:* Phase 5 planning must define: do overrides trigger webhook-like reconciliation? Or is live Stripe data always authoritative? Document this as an architecture decision in Phase 5 planning.

5. **Better Auth admin plugin version compatibility** — Research based on Better Auth 1.6.x, but the project's actual version may vary. *Mitigation:* Phase 0 planning must verify active Better Auth version and confirm admin plugin API surfaces match documentation.

---

## Sources

### Primary (HIGH confidence)

- **react-email v6 changelog** (https://react.email/docs/changelog) — v6.0.0 unified all components into single package, React 19 compatible, includes preview server
- **Resend batch send API** (https://resend.com/docs/api-reference/emails/send-batch-emails) — 100 emails/call limit, rate limit 2 req/sec, `scheduledAt` NOT supported in batch
- **Resend bounce + complaint webhooks** (https://resend.com/docs/api-reference/webhooks) — `svix-id` header for deduplication, at-least-once delivery
- **Better Auth admin plugin** (https://better-auth.com/docs/plugins/admin) — impersonation, ban, role management, `npx auth migrate` for schema changes
- **Vercel Cron Jobs** (https://vercel.com/docs/cron-jobs) — `vercel.json` syntax, `CRON_SECRET` pattern, production-only, function timeout limits
- **STACK.md research** — Drizzle schema patterns, Neon serverless specifics, npm package versions (Q2 2026)
- **ARCHITECTURE.md research** — System diagrams, component responsibilities, data flow patterns, integration boundaries

### Secondary (MEDIUM confidence)

- **RFC 8058 (List-Unsubscribe-Post)** — Gmail/Yahoo enforcement (Feb 2024+) documented in Resend blog and email deliverability literature
- **GDPR email classification** — "Transactional vs. marketing" distinction sourced from GDPR guidelines + community consensus on email compliance (SuprSend, Resend documentation)
- **Better Auth GitHub issues** (#7806 email case-insensitive lookup, OAuth linking edge cases) — community discussion, not official advisory
- **pg_cron unavailable on Neon** — Neon documentation and community reports (Supabase, others all note this limitation)
- **Stripe webhook race conditions** — Multiple production post-mortems (pedroalonso.net, dev.to "the race condition you're shipping right now")
- **WebSocket backpressure + reconnect storms** — WebSocket.org guides, Socket.IO scaling articles, systemoverflow.com

### Tertiary (LOW confidence)

- **Feature flag reuse pitfalls** — Inferred from Knight Capital trading algorithm incident (feature flag repurpose caused $440M loss), not formally documented for SaaS context
- **Daemon install privilege model** — Analogous to CloudFlare Tunnel, AWS SSM Agent security advisories; specific to GSD Cloud daemon not yet researched
- **Admin IDOR and tenant scoping** — Standard security pattern; no specific vulnerability disclosure for this project

---

*Research completed: 2026-06-28*  
*Researched by: 4 parallel researcher agents (STACK, FEATURES, ARCHITECTURE, PITFALLS)*  
*Ready for roadmap: YES*
