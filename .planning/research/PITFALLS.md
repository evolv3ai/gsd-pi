# Pitfalls Research

**Domain:** Cloud-hosted remote agent orchestration platform (WebSocket relay, daemon management, remote shell, multi-tenant, freemium billing)
**Researched:** 2026-06-21
**Confidence:** MEDIUM — cross-checked findings from production post-mortems, CVE disclosures, Socket.IO/Stripe/WebSocket documentation, and known incidents in analogous systems (cloudflared, AWS SSM, LXD, marimo). LOW-confidence claims are tagged.

---

## Critical Pitfalls

### Pitfall 1: Reconnect Storm on Server Restart or Deployment

**What goes wrong:**
When the relay server restarts (rolling deploy, crash recovery, region failover), every connected daemon disconnects simultaneously. If daemons use a fixed retry interval — or even naive exponential backoff without jitter — all reconnection attempts arrive in synchronized waves. Each wave spikes TLS handshakes, authentication token validation, and database lookups at the same time. The server that just recovered gets hammered back down. This extends the outage far beyond the original restart window.

**Why it happens:**
Daemon reconnect logic is written for the happy path (one daemon reconnecting after a transient network blip), not for the correlated-disconnect scenario (hundreds of daemons reconnecting simultaneously after a server event). Jitter is forgotten or dismissed as "good enough later."

**How to avoid:**
- Implement exponential backoff with full jitter on the daemon: `sleep = random(0, min(cap, base * 2^attempt))`. The jitter must be random per daemon, not seeded from device ID.
- Add server-side connection admission rate limiting: accept at most N new WebSocket upgrades per second, queue the rest.
- Set a maximum reconnect interval cap (e.g., 5 minutes) so daemons don't go permanently dark after an extended outage.
- Test reconnect storms explicitly: bring down the relay server with 50+ daemon connections established in a test harness and verify the server recovers without cascading.

**Warning signs:**
- Server CPU spikes sharply on startup before any user traffic.
- Relay server logs show bursts of authentication failures grouped at regular intervals.
- New daemon connections are rejected during what should be a recovery period.
- Reconnect logic uses `setTimeout(retry, BASE_DELAY * Math.pow(2, attempt))` without `Math.random()`.

**Phase to address:**
Daemon connectivity foundation phase. Must be in place before any scale testing or production deployment.

---

### Pitfall 2: WebSocket Backpressure Ignored — Unbounded Server Send Buffers

**What goes wrong:**
The relay server calls `ws.send(message)` for every event destined for a browser client. When a browser tab is backgrounded, the connection is slow, or the client is not draining fast enough, `ws.send()` queues data in an internal Node.js buffer. With no cap, the buffer grows unboundedly. Under sustained message volume this causes the relay server process to run out of memory and crash — taking all other active connections with it. The user-visible symptom is that one slow browser client takes down all connected daemons.

**Why it happens:**
WebSocket send is non-blocking: `ws.send()` returns immediately and the write happens asynchronously. Developers assume the browser will keep up. In production, browsers throttle network activity in background tabs and on constrained connections.

**How to avoid:**
- Check `ws.bufferedAmount` (browser) or `ws.readyState` and `socket.writableLength` (Node.js server) before sending.
- Apply a per-connection send buffer cap (e.g., 256 KB). When exceeded, either drop the oldest queued message or close the connection cleanly with a `1008` (policy violation) close code.
- For project-state snapshot messages, coalesce: if a newer snapshot is queued and an older one is still buffered, drop the older one — the client only needs the latest state.
- Never let one client's slow drain block or crash connections for other clients.

**Warning signs:**
- Server memory grows over time during normal operation and only shrinks when a connection closes.
- Browser clients in background tabs accumulate a visible message backlog when they come to the foreground.
- Relay server crashes with `ENOMEM` or `JavaScript heap out of memory` without a corresponding spike in inbound traffic.

**Phase to address:**
WebSocket relay infrastructure phase. Must be addressed before any real-time state streaming is enabled.

---

### Pitfall 3: Remote Terminal WebSocket Endpoint Without Authentication

**What goes wrong:**
The terminal/shell WebSocket endpoint (`/ws/terminal`) is wired up and functional but its authentication check is missing, incomplete, or checked only on the HTTP upgrade handshake (not re-verified on each command frame). An attacker who discovers the endpoint URL can open a PTY session with the daemon-user's privileges on the target machine. This is not a theoretical risk — it is CVE-class behavior with documented real-world exploits (marimo GHSA-2679-6mx9-h9xc, LXD GHSA-3g72-chj4-2228).

**Why it happens:**
Terminal endpoints are added during rapid prototyping. Developers add authentication to the REST API and the main data WebSocket, then add the terminal endpoint later as a "dev feature," assuming it will be behind a VPN or locked down later. "Later" never comes.

**How to avoid:**
- Every WebSocket endpoint — including terminal/shell — must validate the session token on the HTTP upgrade handshake AND on first message.
- The terminal endpoint must require a short-lived, terminal-specific session token (not the long-lived device pairing token), so the window of exposure is narrow.
- Run the terminal as a subprocess with the least-privileged user available on the daemon host, not as the daemon process owner.
- In the relay server, verify the relay-to-daemon connection map: a browser user can only reach terminal sessions on machines explicitly paired to their account.
- Include the terminal endpoint in security review before any release; mark it as security-critical in code comments.

**Warning signs:**
- The terminal WebSocket endpoint can be reached without a valid session cookie or authorization header.
- The terminal endpoint shares the same authentication middleware as non-sensitive endpoints, without an additional terminal-specific token check.
- PTY sessions are spawned as the user who installed the daemon, which is often the primary user with sudo access.

**Phase to address:**
Remote shell phase. Authentication must be complete and reviewed before the endpoint is enabled in any environment beyond localhost.

---

### Pitfall 4: Multi-Tenant Connection Routing Bug — Wrong Daemon Receives Command

**What goes wrong:**
The relay server maintains a connection map: `{ [deviceId]: WebSocket }`. When a browser client sends a command for device A, the relay looks up `deviceId` and forwards the command. A bug in connection registration — a race between disconnect and reconnect, a stale entry not cleared on disconnect, or a shared global singleton in Node.js that leaks across requests — routes the command to the wrong daemon. User B's browser accidentally controls User A's machine. This is not a data-read leak; it is an active command execution on the wrong machine.

**Why it happens:**
Connection maps are implemented as module-level singletons or simple JavaScript objects. In Node.js, a single-threaded model means concurrent async operations can interleave in unexpected ways during connect/disconnect/reconnect sequences. A disconnect event arrives while a reconnect is being processed; the stale entry is not atomically replaced.

**How to avoid:**
- Scope every connection lookup to `(userId, deviceId)` — never look up by `deviceId` alone. A device ID collision between two users' registries must be impossible.
- Use atomic compare-and-swap semantics on the connection map: when a reconnect registers a new socket, only replace the old entry if it matches the expected old value.
- On disconnect, immediately remove the entry from the map before any cleanup async work.
- Test the concurrent reconnect scenario explicitly: disconnect and reconnect the same device within 50ms while a command is in-flight; assert the command arrives at the correct new connection and the stale connection receives nothing.
- Add per-request tenant assertion middleware: every relay message must include the userId, and the server must verify `connectionMap[userId][deviceId]` matches the authenticated session.

**Warning signs:**
- Connection map entries are keyed by `deviceId` without a user namespace prefix.
- Disconnect events are handled in the same async tick as incoming messages without synchronization.
- Integration tests only cover single-user scenarios.
- The connection registry is a module-level `Map` or plain object shared across all request contexts.

**Phase to address:**
WebSocket relay infrastructure phase. Must be enforced before multi-user testing begins.

---

### Pitfall 5: Opaque Device Token Used as a Long-Lived Credential Without Revocation Path

**What goes wrong:**
Device pairing tokens are generated once, stored in the daemon's config file, and never rotated. If a machine is sold, a config file is committed to a public repo, or a backup is compromised, the attacker has permanent access to that machine's relay connection. The token never expires; there is no "revoke all tokens for this device" function in the UI. Users have no way to clean up a compromised pairing without deleting and re-pairing the device.

**Why it happens:**
Token revocation is treated as a "nice to have" after MVP. The initial implementation stores tokens and checks them on connect but builds no revocation infrastructure. When a token leak is reported, the only mitigation is to delete the account — which is drastic and loses all data.

**How to avoid:**
- Design revocation as a first-class feature from day one: every token is stored with an `is_revoked` flag and a `revoked_at` timestamp in the database.
- Expose a "Revoke device" button in the dashboard that flips `is_revoked` and immediately closes any active WebSocket connection for that device.
- Token validation on WebSocket connect must check `is_revoked` — not just token existence.
- Never store the raw token in your database. Store a bcrypt/Argon2 hash. The user sees the raw token once at pairing time; after that, only the hash is stored.
- Device tokens should be scoped to `(userId, deviceId)` — a token for one device cannot authenticate a different device.
- Consider adding a token rotation mechanism: re-issue tokens every N days with a short grace period for the old token.

**Warning signs:**
- Token table has no `is_revoked` column.
- Token validation query is `SELECT 1 FROM device_tokens WHERE token_hash = $1` without checking revocation status.
- There is no UI affordance to list or revoke individual device tokens.
- Raw token values are stored in the database.

**Phase to address:**
Authentication and device pairing phase. Revocation must be implemented before any device can be paired; retrofitting it after production deployment requires token migration.

---

### Pitfall 6: JWT Used for Daemon Authentication — Revocation Is Impossible at Runtime

**What goes wrong:**
The daemon authenticates to the relay using a JWT signed with a server secret. When a device is stolen or a token is compromised, the team tries to revoke access. But the JWT is valid until its expiry — which was set to 30 days for "convenience." Every relay server instance would need to maintain a blocklist and check it on every connection, which was not built. The only immediate option is to rotate the server signing secret, which revokes all devices simultaneously and requires every user to re-pair.

**Why it happens:**
JWTs feel simpler than opaque tokens: no database lookup on every connection, stateless verification. The revocation gap is acknowledged but deprioritized. The expiry is set long because short expiry means frequent re-pairing UX friction.

**How to avoid:**
- Use opaque tokens for daemon authentication. The relay server validates opaque tokens with a single database lookup on connection — this is acceptable for the connection-establishment path (not per-message).
- If JWTs are used for the relay connection, keep them short-lived (1 hour max) and pair them with a refresh token that can be revoked. The daemon must handle token refresh transparently.
- Never set daemon token expiry to days or weeks without a working revocation path.
- The connection establishment authentication is a one-time cost per session; the marginal cost of a database lookup there is negligible compared to the ongoing message relay cost.

**Warning signs:**
- Token expiry is set to more than 24 hours and the database has no blocklist or revocation table.
- The connection validation path does `jwt.verify(token, SECRET)` with no database call.
- There is no mechanism to immediately terminate an active WebSocket connection when a token is administratively revoked.

**Phase to address:**
Authentication and device pairing phase. The token type decision must be made before any daemon authentication code is written.

---

### Pitfall 7: Stripe Webhook Race Condition — Plan Enforcement Lags Payment State

**What goes wrong:**
A user upgrades from free (1 machine) to paid (unlimited machines). Stripe sends a `checkout.session.completed` webhook. The webhook handler updates the `subscription_status` column. However, the user already attempted to connect a second machine 200ms before the webhook arrived. The plan check ran against the stale `free` state and blocked the connection. The user calls support saying "I just paid and it's not working." The reverse is more dangerous: a user's payment fails, Stripe marks the subscription `past_due`, sends `customer.subscription.updated`, but the webhook arrives out of order after a `invoice.payment_succeeded` from a retry, and the handler sets the status back to `active` — leaving a non-paying user with paid-tier access.

**Why it happens:**
Stripe guarantees at-least-once webhook delivery but not ordering. Teams handle each webhook in isolation, trusting the event's embedded state snapshot rather than re-fetching the live object from the Stripe API.

**How to avoid:**
- On every subscription-relevant webhook (`customer.subscription.updated`, `invoice.paid`, `invoice.payment_failed`), re-fetch the subscription from the Stripe API (`stripe.subscriptions.retrieve(subscriptionId)`) and project the live state — do not trust the embedded `data.object` snapshot.
- Implement idempotency: store the Stripe event ID in a `processed_webhook_events` table with a UNIQUE constraint. On receipt, attempt an INSERT; if it conflicts, return 200 immediately. This prevents double-processing of retried events.
- Return 200 immediately after validation; do subscription state updates asynchronously in a job queue. Stripe times out at 20 seconds; slow processing causes retries and amplifies the race condition.
- Plan enforcement must check the live subscription state from the database at enforcement time — not a cached value from request initialization.

**Warning signs:**
- Webhook handlers use `event.data.object` as the source of truth for subscription state without a re-fetch.
- The `processed_webhook_events` deduplication table does not exist.
- Plan enforcement reads subscription state from a request-scoped cache that could be stale.
- Webhook processing happens synchronously inside the HTTP handler (no job queue).

**Phase to address:**
Billing and subscription phase. Race condition prevention must be built into the webhook handler on day one — retrofitting it after real users are paying is high-risk.

---

### Pitfall 8: Freemium Machine Limit Enforced Only on Connection — Not Continuously

**What goes wrong:**
The "1 machine free" limit is checked when a daemon connects. If the user has 1 machine connected, a second connection is rejected. However: (1) the user connects machine A, then downgrades from paid to free — machine A stays connected and a second machine can now connect because the enforcement only triggers at connection time. (2) Two machines connect simultaneously within the same 50ms window; both pass the "0 machines currently connected" check and both are admitted. The user ends up with 2 free machines.

**Why it happens:**
Enforcement at connection time is the natural implementation point. Continuous enforcement (checking on every message or periodically) feels like over-engineering. The simultaneous connection race is not considered during development.

**How to avoid:**
- Enforce the machine limit with a database-level constraint or a compare-and-swap operation: `UPDATE accounts SET active_connection_count = active_connection_count + 1 WHERE id = $userId AND active_connection_count < $planLimit RETURNING id`. If 0 rows updated, the limit is exceeded. This makes the limit atomic.
- On subscription downgrade, close excess connections proactively (not just block new ones). The relay server must listen for subscription change events and disconnect machines that exceed the new tier's limit.
- Test the simultaneous connect race: establish two connections from two devices within the same event loop tick for the same free-tier user; assert only one succeeds.

**Warning signs:**
- Machine limit enforcement uses a read (`SELECT COUNT(*)`) followed by a conditional write — classic TOCTOU race condition.
- Subscription downgrades are not connected to active connection teardown logic.
- Enforcement logic is in the HTTP WebSocket upgrade handler but not in the subscription state change handler.

**Phase to address:**
Billing and subscription phase AND WebSocket relay infrastructure phase. The atomic connection counter must be in place before the relay goes to production, and the subscription change → connection teardown path must be in place before billing is enabled.

---

### Pitfall 9: Daemon Installed as Root — Privilege Escalation via Remote Shell

**What goes wrong:**
The daemon installer uses `sudo` for convenience (to install the launchd plist to `/Library/LaunchDaemons/` or the systemd unit to `/etc/systemd/system/`). The daemon process runs as root. When remote shell access is enabled, the browser user gets a root PTY. Any command injection vulnerability, SSRF against localhost services, or directory traversal in the filesystem browser gives the attacker root on the user's machine.

**Why it happens:**
Running as root is the easiest way to ensure the daemon can read all project files regardless of permissions. The security implications are accepted as "the user is connecting to their own machine anyway."

**How to avoid:**
- Install the daemon to run as the logged-in user (`~/Library/LaunchAgents/` on macOS, a user systemd unit on Linux) — not as root.
- On macOS, the launchd plist must be owned by the user, installed in `~/Library/LaunchAgents/`, and must not fork or call `daemon()`.
- For the rare case where system-level access is needed, use a minimal privilege helper with an explicit entitlement, not a full root daemon.
- Remote shell sessions spawned by the daemon must run as the daemon user — never escalate. Apply `no-new-privileges` at the PTY spawn site.
- Filesystem browsing must restrict path traversal: validate that all requested paths are under the user's home directory or an explicitly configured project root; reject `../` sequences after normalization.

**Warning signs:**
- The install script contains `sudo launchctl load` and installs to `/Library/LaunchDaemons/`.
- The daemon process's effective UID is 0 (root) during normal operation.
- PTY spawn code does not set `uid`/`gid` on the child process.
- Filesystem browse API uses `path.join(requestedPath)` without validating the result is still under the allowed root.

**Phase to address:**
Daemon packaging and installation phase. The privilege model must be locked before any beta testers install the daemon.

---

### Pitfall 10: Sticky Session Load Balancing — Server Failure Takes Out All Pinned Clients

**What goes wrong:**
The relay server is scaled horizontally behind a load balancer with sticky sessions (IP hash or cookie affinity). Each daemon is pinned to a specific relay server instance. When one instance crashes or is drained for deployment, all daemons pinned to it disconnect simultaneously and attempt to reconnect to other instances. The surviving instances see a surge of new connections from daemons that had no backpressure relief on their reconnect timers (see Pitfall 1 compounding). Additionally, rolling deployments become disruptive: you cannot drain one server without disconnecting all its clients.

**Why it happens:**
Sticky sessions are the easiest way to make WebSocket connections work behind a standard load balancer without shared state. Teams ship with sticky sessions as a "temporary" solution and never migrate off it.

**How to avoid:**
- Add a Redis pub/sub backplane from the start: when the relay receives a message for a daemon that is connected to a different relay instance, publish to Redis; the owning instance receives and forwards. This removes the need for sticky sessions.
- Store connection state (which daemon is on which relay instance) in Redis with a TTL slightly longer than the reconnect timeout, so state is self-healing.
- Use `least_conn` load balancing (not round-robin) — WebSocket connections are long-lived; round-robin creates uneven distribution over time.
- Design the daemon so reconnecting to a different relay instance requires no re-pairing — the token is valid on any instance.

**Warning signs:**
- Load balancer is configured with IP hash or `SERVERID` cookie affinity.
- The connection registry is a process-local `Map` not backed by Redis or another shared store.
- Deploying a new relay version requires a maintenance window.
- A relay instance restart causes users to see "all machines offline" until daemons reconnect.

**Phase to address:**
WebSocket relay infrastructure phase. The pub/sub backplane decision must be made before the first multi-instance deployment.

---

### Pitfall 11: Ghost Sessions — Stale Daemon Connections Not Detected

**What goes wrong:**
A daemon process is killed (machine sleeps, network interface changes, process crash) without sending a WebSocket close frame. The relay server's TCP connection is half-open: from the server's perspective the connection is alive; from the user's dashboard the machine appears "online." Commands sent to that daemon time out silently. The browser user sees the machine as reachable but nothing works.

**Why it happens:**
TCP keepalive is configured at the OS level with long timeouts (minutes to hours). The application-level ping/pong is either not implemented or has a timeout too long to detect laptop sleep/wake cycles.

**How to avoid:**
- Implement application-level ping/pong with a heartbeat interval of 30 seconds and a timeout of 60 seconds. If the daemon does not respond to a ping within 60 seconds, close the connection server-side and mark the machine as offline.
- The daemon must send a WebSocket close frame on clean shutdown (SIGTERM handler). Register `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` in the daemon.
- On the dashboard, distinguish "online" from "responding" — show last-seen-at timestamp rather than a binary online/offline indicator.
- Test the sleep/wake scenario: put a laptop running the daemon to sleep; verify the relay detects disconnection within 90 seconds.

**Warning signs:**
- No application-level ping/pong implementation in the relay or daemon.
- Dashboard shows "online" for machines that have been offline for hours.
- There is no SIGTERM handler in the daemon that sends a WebSocket close frame.
- The relay's connection list grows monotonically and never shrinks except when the relay restarts.

**Phase to address:**
Daemon connectivity foundation phase. Heartbeat must be implemented before any UI shows machine presence status.

---

### Pitfall 12: Message Delivery Assumes Exactly-Once — No Acknowledgment or Replay

**What goes wrong:**
The relay server sends a command result (or project state update) to the browser client. The WebSocket disconnects at the exact moment the message is in-flight. The message is lost. When the browser reconnects, it renders stale state — or worse, the user retries the command and it executes twice on the daemon because the "first" command actually arrived and executed but its result was lost.

**Why it happens:**
WebSocket gives TCP's in-order delivery within a session, but provides no cross-session delivery guarantee. Message loss on disconnect is the correct TCP behavior; the application layer must add reliability if needed.

**How to avoid:**
- For command execution: implement a request-response ID scheme. Each command carries a `requestId`. The daemon acknowledges execution with the same `requestId`. The relay stores pending-acknowledgment commands with a TTL. If the browser client reconnects before TTL expires, the relay can deliver the deferred result.
- For state updates (project snapshots): use a "resync on reconnect" pattern. When the browser WebSocket reconnects, the first message is always a full state snapshot — no delta-only recovery. This is simpler and more robust than replay.
- Make command dispatch idempotent where possible (GSD commands that are already idempotent are safe to retry; commands with side effects must be guarded by the `requestId` deduplication).

**Warning signs:**
- Command messages carry no correlation ID.
- Browser reconnect does not trigger a re-fetch of current state.
- There is no acknowledgment protocol between relay and browser.
- Users can trigger the same GSD command twice by refreshing during execution.

**Phase to address:**
WebSocket relay infrastructure phase. The reliability model must be decided before the command execution protocol is finalized.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Fixed retry interval for daemon reconnect (no jitter) | Simpler reconnect logic | Reconnect storm on any server restart; amplified outage duration | Never — jitter costs 1 line of code |
| JWT for daemon auth (no database lookup on connect) | Stateless, no DB dependency at connection time | No immediate revocation path; compromised token valid until expiry | Only if expiry ≤ 1 hour AND refresh + revocation path is built in the same phase |
| Sticky sessions for WebSocket load balancing | No Redis dependency to start | Deployment disruption; single-instance failure disconnects all pinned clients; cannot scale horizontally without downtime | Only as temporary measure for initial single-instance deployment |
| Plan limit check via SELECT COUNT(*) then conditional INSERT | Simple, readable | TOCTOU race allows simultaneous connects to bypass limit | Never — use atomic compare-and-swap in a single query |
| Daemon installed as root/system daemon | Access to all files guaranteed | Remote shell gives attacker root; privilege escalation blast radius is total machine compromise | Never for the relay-connected daemon; acceptable only for a narrow privilege-helper binary |
| Webhook handler trusts `event.data.object` without re-fetch | Fewer API calls, lower latency | Out-of-order events produce wrong subscription state; paying users lose access, lapsed users retain it | Never — the re-fetch cost is negligible vs. the support cost |
| Skip application-level ping/pong (rely on TCP keepalive) | No heartbeat implementation | Ghost sessions; machines appear online for hours after disconnect; commands time out silently | Never for a system that shows machine presence status to users |

---

## Integration Gotchas

Common mistakes when connecting to external services in this system.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Stripe webhooks | Processing synchronously in the HTTP handler | Return 200 immediately, enqueue event processing asynchronously; Stripe times out at 20s and retries, amplifying duplicates |
| Stripe webhooks | Trusting `event.data.object` as current state | Re-fetch `stripe.subscriptions.retrieve(id)` on every subscription event to project live state |
| Stripe webhooks | No deduplication | Store event ID in `processed_webhook_events` with UNIQUE constraint; return 200 on conflict |
| macOS launchd | Installing to `/Library/LaunchDaemons/` (system) | Install to `~/Library/LaunchAgents/` (user); plist must be owned by user, not call `daemon()`, not fork |
| systemd | Running daemon as `root` user in unit file | Use `User=<username>` in the unit file; grant only the permissions the daemon needs |
| Redis pub/sub | Using Redis as the connection registry (long-term state) | Redis pub/sub is for message routing between relay instances; connection state with TTL goes in Redis; authoritative device-user mapping stays in the database |
| WebSocket terminals | Reusing the main relay auth middleware for the terminal endpoint | Terminal endpoint requires an additional short-lived terminal session token; validate it separately from the device pairing token |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Per-message database lookup for authorization | High DB query volume, latency spikes on active connections | Cache authorized `(userId, deviceId)` pairs in memory at connection time; re-verify only on reconnect or token refresh | ~1,000 concurrent connections with active message throughput |
| Synchronous filesystem operations in daemon | Terminal commands block the daemon's event loop; other relay messages queue up | All filesystem operations must be async; use `fs.promises.*`, never `fs.*Sync` in daemon hot paths | First time a user runs `find /` through the terminal |
| Single relay server with all connections | No horizontal scale path; one server restart disconnects everyone | Design connection registry with Redis from the start; even at 10 connections, getting the architecture right early costs little | ~500 concurrent daemon connections on a single Node.js process |
| Full project state broadcast on every change | Large payloads; growing number of subscribers means O(n) fan-out work on every task update | Implement incremental/differential state updates; only broadcast what changed | ~20 concurrent watchers of the same machine's project state |
| Device token validation with bcrypt on every WebSocket message | bcrypt is intentionally slow (100ms+); used for token hashing not per-message auth | Token is validated at connection establishment only; cache the validated identity for the lifetime of the connection | Any production traffic — a single active connection would saturate a core |

---

## Security Mistakes

Domain-specific security issues for a remote agent orchestration platform.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Terminal WebSocket endpoint reachable without per-endpoint auth | Pre-auth RCE (documented CVE class: marimo GHSA-2679-6mx9-h9xc, LXD GHSA-3g72-chj4-2228) | Validate auth on every WebSocket upgrade, not just on REST routes; terminal endpoint requires additional short-lived token |
| Filesystem browse API does not normalize and validate paths | Directory traversal: attacker reads `/etc/passwd`, `/Users/victim/.ssh/id_rsa`, etc. | Normalize path with `path.resolve()`, then assert result starts with `allowedRoot`; reject any path that escapes the root |
| Relay server routes commands by `deviceId` alone (no user scope) | Cross-tenant command execution: User A controls User B's machine | All connection lookups must be `(userId, deviceId)`; assert userId matches authenticated session on every relay operation |
| Raw device token stored in database | Token database dump gives attacker access to all paired devices | Store bcrypt/Argon2 hash only; return raw token to user once at pairing time |
| SSRF via remote command execution to localhost services | Daemon can be used to reach localhost:9200 (Elasticsearch), localhost:6379 (Redis), cloud metadata endpoints (169.254.169.254) | Block localhost/private range requests in any URL-fetching code the daemon can execute; treat cloud metadata IPs as blocked |
| WebSocket session token stored in localStorage | XSS on the dashboard reads token; attacker hijacks relay session | Store session token in HttpOnly Secure SameSite=Strict cookie; never in localStorage or JavaScript-accessible storage |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Daemon reconnect:** Uses exponential backoff with random jitter, not fixed interval — verify by checking the reconnect timer formula for `Math.random()` multiplication.
- [ ] **Plan limit enforcement:** Machine count increment is an atomic compare-and-swap query, not a read-then-write — verify by running two simultaneous connection attempts for a free-tier account and asserting only one succeeds.
- [ ] **Token revocation:** The `is_revoked` flag is checked on WebSocket connect, not just token existence — verify by revoking a token and confirming the daemon is disconnected within the next heartbeat cycle.
- [ ] **Terminal auth:** The terminal WebSocket endpoint validates auth independently of other WebSocket endpoints — verify by attempting to connect to `/ws/terminal` with an expired or missing token and confirming it is rejected.
- [ ] **Webhook idempotency:** Stripe event IDs are stored with UNIQUE constraint deduplication — verify by replaying the same webhook event twice and confirming the subscription state is updated exactly once.
- [ ] **Ghost session detection:** Application-level ping/pong closes connections within 90 seconds of daemon disconnect — verify by killing the daemon process without a clean close and confirming the relay marks the machine offline.
- [ ] **Filesystem path traversal:** All filesystem browse paths are normalized and validated against the allowed root — verify by requesting `../../etc/passwd` and confirming a 403 is returned, not file contents.
- [ ] **Daemon privilege:** The daemon process runs as the logged-in user (UID != 0) — verify with `ps aux | grep gsd-agent` after installation.
- [ ] **Subscription downgrade → connection teardown:** Downgrading to free while 2 machines are connected closes the excess connection — verify by downgrading a paid account with 2 active daemons and confirming only 1 remains connected.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Reconnect storm crashes relay on deploy | HIGH | Rate-limit new connections at the load balancer (1 connection/second threshold); add jitter to daemon reconnect before next deploy; use a staged rollout (1 instance at a time) |
| Cross-tenant command routing bug discovered in production | CRITICAL | Immediately disable remote command execution; audit relay logs for any cross-user routing events; patch `(userId, deviceId)` scoping; notify affected users; consider mandatory security disclosure |
| Device token leaked via config file committed to git | HIGH | Revoke the specific token immediately; if revocation wasn't built: rotate the signing key (breaking all devices) and require re-pairing; add `gsd-agent.conf` to `.gitignore` across all user docs |
| Stripe webhook out-of-order event causes wrong plan state | MEDIUM | Re-fetch live subscription state from Stripe API for affected users; reconcile database against Stripe; add the re-fetch pattern to all future webhook handlers |
| Ghost sessions accumulate (machine appears online, is not) | LOW | Restart the relay server to clear all stale connections (daemons reconnect cleanly); implement heartbeat before next release |
| Daemon installed as root, vulnerability discovered | CRITICAL | Push a daemon update that reinstalls as user-scoped; revoke all active sessions and require re-pairing after update; treat as security incident |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Reconnect storm (no jitter) | Daemon connectivity foundation | Simulated server restart with 50 daemons; server recovers in under 60 seconds |
| Unbounded send buffers (backpressure) | WebSocket relay infrastructure | Load test with a throttled browser client; server memory stays flat |
| Terminal endpoint without auth | Remote shell phase | Security review; auth bypass attempt returns 401, not a PTY |
| Wrong-tenant connection routing | WebSocket relay infrastructure | Concurrent multi-user test; User A command never reaches User B's daemon |
| Token without revocation path | Authentication and device pairing | Revoke a token; daemon disconnects within one heartbeat cycle |
| JWT with no revocation (long-lived) | Authentication and device pairing | Token type decision is documented; if JWT, expiry ≤ 1h and refresh flow works |
| Stripe webhook race condition | Billing and subscription | Replay out-of-order webhook events; subscription state matches Stripe live API |
| Machine limit TOCTOU race | Billing and subscription AND relay infrastructure | Simultaneous connection test for free-tier; exactly 1 connection succeeds |
| Daemon installed as root | Daemon packaging and installation | `ps aux` shows daemon running as user, not root; launchd plist in `~/Library/LaunchAgents/` |
| Sticky session scaling fragility | WebSocket relay infrastructure | Single relay instance restart does not cause permanent disconnection |
| Ghost sessions (no heartbeat) | Daemon connectivity foundation | Kill daemon without close frame; relay marks machine offline within 90 seconds |
| No message delivery acknowledgment | WebSocket relay infrastructure | Disconnect browser mid-command; reconnect and verify result is delivered and command not duplicated |

---

## Sources

- [WebSocket reconnect storms and thundering herd — systemoverflow.com](https://www.systemoverflow.com/learn/networking-protocols/websockets/failure-modes-reconnect-storms-slow-consumers-and-tcp-head-of-line-blocking)
- [Reconnect storm mitigation strategies — amirsoleimani.medium.com](https://amirsoleimani.medium.com/deal-with-reconnection-storm-two-strategies-4a835d0457f6)
- [WebSocket backpressure and connection limits — websocket.org](https://websocket.org/guides/connection-limits/)
- [Node.js WebSockets in production: scaling and reconnection — dev.to/axiom_agent](https://dev.to/axiom_agent/nodejs-websockets-in-production-socketio-vs-ws-scaling-and-reconnection-strategies-5b68)
- [Pre-auth RCE via terminal WebSocket authentication bypass — marimo GHSA-2679-6mx9-h9xc](https://github.com/marimo-team/marimo/security/advisories/GHSA-2679-6mx9-h9xc)
- [WebSocket session hijacking and privilege escalation — LXD GHSA-3g72-chj4-2228](https://github.com/canonical/lxd/security/advisories/GHSA-3g72-chj4-2228)
- [Multi-tenant leakage when row-level security fails — instatunnel.my](https://instatunnel.my/blog/multi-tenant-leakage-when-row-level-security-fails-in-saas)
- [Cross-tenant data leaks: why API hackers look for CTDL — danaepp.com](https://danaepp.com/cross-tenant-data-leaks-ctdl-why-api-hackers-should-be-on-the-lookout)
- [JWT vs opaque tokens for device auth — igventurelli.io](https://igventurelli.io/jwt-vs-opaque-tokens-a-comprehensive-guide-to-choosing-wisely/)
- [JWT revocation and token lifecycle management — skycloak.io](https://skycloak.io/blog/jwt-token-lifecycle-management-expiration-refresh-revocation-strategies/)
- [Stripe webhook race conditions — pedroalonso.net](https://www.pedroalonso.net/blog/stripe-webhooks-solving-race-conditions/)
- [Stripe webhook idempotency and ordering — amplifiedcreations.com](https://amplifiedcreations.com/journal/stripe-subscription-webhooks)
- [Stripe race condition: the one you're probably shipping right now — dev.to/belazy](https://dev.to/belazy/the-race-condition-youre-probably-shipping-right-now-with-stripe-webhooks-mj4)
- [WebSocket delivery guarantees — socket.io](https://socket.io/docs/v4/delivery-guarantees)
- [WebSocket reliability in realtime infrastructure — ably.com](https://ably.com/topic/websocket-reliability-in-realtime-infrastructure)
- [WebSocket horizontal scaling with Redis pub/sub — websocket.org](https://websocket.org/guides/websockets-at-scale/)
- [Sticky session pitfalls and Redis adapter for Socket.IO — ably.com](https://ably.com/topic/scaling-socketio)
- [macOS launchd daemon requirements — developer.apple.com](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [cloudflared system service management cross-platform — deepwiki.com](https://deepwiki.com/cloudflare/cloudflared/8.1-build-process)
- [Ghost sessions from remote-control connections — claude-code issue #29205](https://github.com/anthropics/claude-code/issues/29205)
- [AWS SSM Agent path traversal in plugin ID validation — cymulate.com](https://cymulate.com/blog/aws-ssm-agent-plugin-id-path-traversal/)
- [SSRF via AI agent shell access — wiz.io](https://www.wiz.io/blog/red-agent-pov-ssrf)

---

*Pitfalls research for: GSD Cloud — cloud-hosted remote agent orchestration platform*
*Researched: 2026-06-21*

---

## Milestone Addendum: Activity Notifications, Onboarding, Responsive Layout, Search, and OAuth

**Added:** 2026-06-22
**Scope:** Common mistakes when ADDING these features to the existing GSD Cloud system (milestone 2).
**Confidence:** LOW (web community knowledge, not formally documented post-mortems).

---

### Pitfall 13: Notification Badge Count Initializes at Zero on Page Load

**What goes wrong:**
The unread notification count is managed entirely through WebSocket delta events. When the user opens the app in a new tab, the badge starts at 0 because no WS events have arrived yet — even if there are 12 unread notifications in the database. The badge only increments as new events arrive in the current session. Users see "0 unread" and miss existing notifications until they happen to receive a new one.

**Why it happens:**
The WS event handler that increments the badge is written first, making it feel like the count is "live." The initialization from a REST endpoint feels redundant and is left as a TODO. The TODO ships.

**How to avoid:**
- On page load (or tab focus after reconnect), fetch the authoritative unread count from `GET /api/notifications/unread-count` and initialize the badge from that value.
- WebSocket events then delta-update the badge: `+1` on new notification, `-N` on mark-as-read.
- The REST endpoint is the source of truth; WS is the live-update layer, not the initializer.

**Warning signs:**
- Badge count resets to 0 every time the tab is refreshed.
- Existing unread notifications only appear after a new notification arrives.
- The badge count initialization is commented "TODO: fetch from API."

**Phase to address:**
Activity notifications phase. Initialize-from-REST must be wired before any badge UI is shipped.

---

### Pitfall 14: Multi-Tab Notification Deduplication Failure

**What goes wrong:**
The user has two tabs open. Both tabs maintain their own WebSocket connection to the relay. Both connections receive the same notification event. The user gets two toast popups and the badge count is incremented twice (badge shows 2, actual unread is 1).

**Why it happens:**
Each tab is treated as an independent client. The deduplication logic that avoids double-display is not built because "who has two tabs open?" — many power users do.

**How to avoid:**
- Include a unique `notificationId` in every notification payload regardless of channel.
- On the client, track seen notification IDs in a `Set` stored in sessionStorage or a shared `BroadcastChannel` across tabs.
- When a notification arrives via WS, check the seen-ID set before displaying a toast or incrementing the badge.
- Use the BroadcastChannel API to coordinate across same-origin tabs: when Tab A marks a notification as read, Tab B's badge should also decrement.

**Warning signs:**
- Notification payload has no stable unique ID.
- Toast library is called directly inside the WS message handler without a deduplication check.
- No BroadcastChannel coordination between tabs.

**Phase to address:**
Activity notifications phase.

---

### Pitfall 15: WebSocket Missed Events During Reconnect Gap

**What goes wrong:**
The daemon sends 8 activity events while the browser's WS connection is down (network hiccup, browser sleep, 60-second reconnect backoff). When the connection re-establishes, the browser resumes receiving new events — but the 8 missed events are lost. The activity feed has a gap; unread count is lower than actual. The user thinks their machines were idle when they were actually running jobs.

**Why it happens:**
WebSocket guarantees in-order delivery within a session, not across sessions. The server never retains sent events; it fires and forgets.

**How to avoid:**
- On reconnect, the client sends a `lastSeenEventId` or `since` timestamp in the connection handshake.
- The server replays all events newer than `lastSeenEventId` from a short-duration buffer (last 30 minutes, bounded to ~100 events per user).
- Events must be idempotent on the client side (use event ID deduplication from Pitfall 14) so replayed events do not cause double display.
- If no buffer is implemented, at minimum fetch the full notification list from REST on every reconnect and reconcile against what the client has cached.

**Warning signs:**
- The WS server has no event buffer or message history.
- Reconnect handler does not include any "catch me up" mechanism.
- Activity feed shows gaps when network connectivity is intermittent.

**Phase to address:**
Activity notifications phase. The reconnect replay decision must be made before the event emission architecture is finalized.

---

### Pitfall 16: OAuth Account Linking Creates Duplicate Users (Email Case Mismatch)

**What goes wrong:**
A user registered with `johndoe@example.com` (email/password). They later sign in with GitHub, which returns `JohnDoe@example.com` (capitalized). Better Auth performs a case-sensitive email lookup, finds no match, and creates a second account. The user now has two accounts — neither linked — and their existing projects and machines are on the original account they can no longer easily access via OAuth.

**Why it happens:**
Better Auth issue #7806 documents this as a known bug. Email lookup uses exact string matching. Email addresses are case-insensitive by convention (RFC 5321 local part is technically case-sensitive but all major providers treat it as case-insensitive). Developers assume the database's existing lowercase email will match any casing the provider returns.

**How to avoid:**
- Normalize emails to lowercase before any INSERT or lookup. Apply this at the database layer (a `CHECK (email = lower(email))` constraint + lowercase on write) and at the application layer.
- When adding a new OAuth provider flow, explicitly test with a test account whose stored email differs in case from what the provider returns.
- Until Better Auth patches the case-insensitive lookup natively, add a pre-lookup normalization step in the auth configuration.

**Warning signs:**
- `users` table has rows with mixed-case email values.
- The auth signup flow does not `email.toLowerCase()` before writing.
- Duplicate user rows exist in the database with identical emails differing only in casing.

**Phase to address:**
OAuth integration phase. Must be implemented before Google/GitHub sign-in is available to users.

---

### Pitfall 17: OAuth Auto-Linking Without Verified Email Flag Enables Account Takeover

**What goes wrong:**
The system is configured to auto-link a new OAuth sign-in to an existing email/password account when the emails match. An attacker creates a GitHub account with `victim@example.com` — GitHub does not verify this email before allowing sign-in. The attacker signs into GSD Cloud with GitHub, the system finds the existing `victim@example.com` account and links them, and the attacker now has full access to the victim's account.

**Why it happens:**
Email is treated as a stable, trustworthy identity anchor. Developers do not realize that OAuth providers vary widely in whether they verify email ownership before issuing tokens, and that the `email_verified` field exists for exactly this reason.

**How to avoid:**
- Before auto-linking an OAuth account to an existing email/password account, check that the OAuth provider's token response includes `email_verified: true`.
- GitHub returns `email_verified` on the `/user/emails` endpoint (not `/user`). If `email_verified` is false, reject the auto-link and require the user to sign in with their password to confirm ownership, then link manually.
- Do not treat email alone as a sufficient linking key — link by `(provider, provider_account_id)` as primary key; email is only a lookup hint, not the authoritative link.
- Better Auth's `accountLinking.requireEmailVerification` option should be enabled.

**Warning signs:**
- Account linking does not check `email_verified` from the OAuth token response.
- Linking happens automatically on every OAuth sign-in without user confirmation.
- The `accounts` table links by email only, not by provider + sub ID.

**Phase to address:**
OAuth integration phase. This is a security requirement, not a nice-to-have; it must be verified before OAuth providers are enabled in production.

---

### Pitfall 18: OAuth-First Users Cannot Add Email/Password (Asymmetric Linking Bug)

**What goes wrong:**
A user signs up via "Continue with Google." Later they want to set a password (in case their Google account is unavailable). The "Add password" flow fails silently or returns an error. The reverse — email/password user adding Google — works fine. This is a directional bug in Better Auth v1.3.x that may persist in some 1.6.x configurations.

**Why it happens:**
The account linking logic handles the email/password → OAuth direction but not the OAuth → email/password direction. The `setPassword` server API exists but is not wired to a UI flow, or the client-side `linkSocial` → `setPassword` sequence has an undocumented prerequisite.

**How to avoid:**
- Test the OAuth-first → add-password flow explicitly in a test environment before shipping.
- Use Better Auth's server-side `setPassword` API (not the client-side flow) for setting a password on an OAuth-first account.
- Check the Better Auth changelog and open issues for the specific 1.6.x version in use to see if this bug is patched.
- Provide a "Connect accounts" UI that explicitly shows which auth methods are linked and allows linking/unlinking each.

**Warning signs:**
- "Add password" button exists in settings but the backend call returns 400 or silently fails for OAuth-first accounts.
- No test covers the OAuth-sign-up → set-password flow end-to-end.
- The auth settings UI shows linked accounts but no way to add a password credential to an OAuth-only account.

**Phase to address:**
OAuth integration phase. Test both directions of account linking before shipping.

---

### Pitfall 19: Onboarding Wizard Becomes Stale as Product Evolves

**What goes wrong:**
The onboarding wizard ships with step 3 saying "Click 'Connect Machine' in the top-right menu." In the next milestone, "Connect Machine" moves to the sidebar. The wizard copy now references a button that doesn't exist where described. New users follow the wizard, get confused, give up, or submit support tickets. The wizard is rarely updated because it lives outside the main feature development loop.

**Why it happens:**
Onboarding copy is written once and treated as done. There is no mechanism to flag when a referenced UI element moves or is renamed. Developers fix the feature without checking if the wizard references it.

**How to avoid:**
- Tie wizard steps to feature flags or step IDs, not hardcoded copy. Each step is a record in a config or database that can be updated independently.
- Include onboarding copy in the definition of done for any UI change that affects wizard-referenced features ("does this change any wizard step?").
- Track wizard drop-off rates per step; a sudden spike in abandonment on step 3 is a signal that step 3 is broken.
- Build a preview mode for the wizard so it can be verified in production without affecting real users.

**Warning signs:**
- Wizard copy is hardcoded in JSX components with no abstraction layer.
- No analytics on wizard step completion/abandonment.
- Onboarding content is not part of the definition of done for feature changes.

**Phase to address:**
Onboarding phase. Instrumentation and update workflow must be built alongside the wizard, not retrofitted later.

---

### Pitfall 20: Onboarding Gates Users Behind Steps Before They See Value

**What goes wrong:**
The wizard requires: (1) email verification, (2) full profile completion, (3) a 6-step product tour, then (4) finally connecting a machine — at which point the user sees their first real data. Time-to-value is 10+ minutes. Users abandon during mandatory email verification or the product tour, long before they understand what GSD Cloud actually does for them.

**Why it happens:**
Teams front-load safety and completeness requirements (verified email, complete profile) before realizing that users who don't see value in 5 minutes never return to complete those requirements anyway.

**How to avoid:**
- Define "value moment" first: for GSD Cloud it is seeing at least one connected machine's project status in the dashboard. Everything in onboarding should reduce the time to that moment.
- Defer email verification to a soft-nudge after first machine connection, not a hard gate before it.
- Make the product tour skippable and cap it at 3 steps maximum; replace it with contextual empty-state guidance in the dashboard itself.
- Target time-to-value under 5 minutes from signup to seeing live machine data.

**Warning signs:**
- Email verification is required before the user can access the dashboard at all.
- The product tour has more than 3 steps and is not skippable.
- Profile completion is a blocking step with no "skip for now" option.

**Phase to address:**
Onboarding phase. Time-to-value must be measured and below 5 minutes before onboarding ships.

---

### Pitfall 21: Fixed-Width Dashboard Breaks Horizontally on Mobile When Retrofitted

**What goes wrong:**
The existing dashboard uses fixed `w-[800px]` or `min-w-[640px]` on the main content area and sidebar. A developer adds Tailwind responsive prefixes to some components but misses the root container. On mobile, the fixed-width container overflows the viewport, creating a horizontal scrollbar. The layout "technically works" but is unusable: users must scroll sideways to access the sidebar navigation.

**Why it happens:**
Tailwind's responsive system is mobile-first: unsuffixed utility classes apply at ALL breakpoints, including mobile. When the existing desktop code uses unsuffixed `w-[800px]`, adding `md:` breakpoints to child components does not help — the parent still fixes the width. Developers audit children but miss the root container.

**How to avoid:**
- Before adding any responsive classes, audit every unsuffixed `w-[*px]` and `min-w-[*px]` in layout containers (app shell, main content area, sidebar). These are the roots of breakage.
- Retrofit strategy: replace fixed pixel widths with `max-w-[800px] w-full` — this preserves the desktop cap while allowing the container to shrink on small screens.
- Use `min-w-0` on flex children to prevent them from overflowing their parent (flex children default to `min-width: auto` which can cause overflow).
- Test every viewport from 320px to 1440px using browser devtools before declaring a layout responsive.

**Warning signs:**
- Horizontal scrollbar appears at any viewport width below ~900px.
- `w-[px]` or `min-w-[px]` values in layout-level components (not decorative or icon sizing).
- Responsive testing was only done at standard breakpoints (640/768/1024) not at arbitrary intermediate widths.

**Phase to address:**
Dashboard responsive layout phase. Audit fixed-width roots before adding any responsive breakpoints.

---

### Pitfall 22: Fixed Sidebar Becomes a Viewport-Blocking Overlay on Mobile

**What goes wrong:**
The sidebar uses `fixed` or `sticky` positioning and a fixed width (e.g., `w-64`). On mobile, the sidebar consumes the entire viewport width, or overlaps all content with no way to close it. The main content area is unreachable. No mobile hamburger toggle exists because the desktop design never needed one.

**Why it happens:**
The sidebar was designed desktop-first with no mobile consideration. When adding responsiveness, developers add `hidden md:block` to hide the sidebar on mobile but forget to add the mechanism to show it — so the sidebar is simply gone on mobile with no navigation at all.

**How to avoid:**
- On mobile, convert the sidebar to a slide-in drawer: hidden by default, shown when a hamburger/menu button is tapped.
- The drawer state (`isOpen: boolean`) must be stored in a component or context that persists across route changes — local state in the sidebar component resets to closed on every navigation.
- Add an overlay backdrop (semi-transparent `div`) behind the drawer; tapping it closes the drawer.
- Ensure the close gesture works: Escape key, backdrop tap, and explicit close button.
- Never use just `hidden md:block` without a corresponding mobile reveal mechanism.

**Warning signs:**
- Sidebar has `position: fixed` or `sticky` with no responsive width override.
- No hamburger button or menu toggle exists in the mobile breakpoint layout.
- The sidebar is hidden on mobile (`hidden md:block`) but there is no `<MobileNav>` equivalent to replace it.

**Phase to address:**
Dashboard responsive layout phase. Mobile navigation must be complete before any responsive work is considered done.

---

### Pitfall 23: Search Command Palette Causes Hydration Mismatch in Next.js App Router

**What goes wrong:**
The command palette (Cmd+K quick-switch) uses `cmdk` or a similar client-only library. It is imported directly in a Server Component or without `dynamic(() => import(...), { ssr: false })`. Next.js renders the server HTML without the component; the browser hydrates with the component present, causing a React hydration error. The error manifests as a blank page or console warnings in development but silent breakage in production.

**Why it happens:**
`cmdk` uses browser APIs (keyboard events, `document`) that do not exist in the Node.js server rendering environment. Developers import it like any other component, forgetting that App Router Server Components render on the server.

**How to avoid:**
- Import the command palette component with `const CommandPalette = dynamic(() => import('./command-palette'), { ssr: false })`.
- Wrap any `useSearchParams()` consumers (URL-synced search) in a `<Suspense>` boundary — Next.js App Router requires this and will throw a build-time error otherwise.
- Test the command palette component with `next build && next start`, not just `next dev` (dev mode is more forgiving of hydration issues).

**Warning signs:**
- `cmdk` or similar DOM-dependent library is imported without `dynamic()` in a component file that does not have `'use client'` at the top.
- Hydration errors appear in browser console when the search palette is loaded.
- `useSearchParams` is used without a wrapping `<Suspense>`.

**Phase to address:**
Search and quick-switch phase.

---

### Pitfall 24: Client-Side Search Over WebSocket State Produces Stale Results Mid-Update

**What goes wrong:**
The machine list and project list are populated from WebSocket push events. The user types in the search box; the client filters the in-memory list. At that moment a new WS event updates the list — the filtered view flickers or resets because the underlying array reference changed and React re-renders the full list. Alternatively, the search shows a machine that just went offline (still in local state but now stale).

**Why it happens:**
WebSocket state and search state are managed independently. The search filter is applied directly to the live WS-updated array without debouncing or snapshotting. Rapid WS updates during a search reset the filtered view.

**How to avoid:**
- Search input must be debounced (250ms) so rapid keystrokes do not fire repeated filters.
- Apply the search filter to a snapshot of the list, not the live reactive store. On a WS update, re-apply the current search term to the new snapshot; do not reset the search term.
- For cross-machine search (searching project names across all connected machines), debounce and send a server-side query rather than filtering in-browser — the data set grows with the number of machines.
- Stale data problem: show a "last updated at" timestamp on machine cards rather than implying the data is always live.

**Warning signs:**
- Search input causes visible flicker on every WS update while the user is typing.
- Typing in search and then receiving a WS event resets the search results to the full list.
- Search over machines queries the in-memory WS state without a server-side query option.

**Phase to address:**
Search and quick-switch phase.

---

## Milestone Addendum Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Better Auth + Google OAuth | `redirect_uri_mismatch` in production because `baseURL` not explicitly set | Set `baseURL` to the production URL in Better Auth config; never let it default |
| Better Auth + GitHub OAuth | Primary email returns null on `/user` endpoint | Must include `user:email` scope and call `/user/emails` to get verified primary email |
| Better Auth + Google OAuth | Refresh token missing after user re-authorizes | Google only issues refresh token on first consent; store it immediately and handle the missing-refresh-token case gracefully |
| Better Auth account linking | Cross-provider duplicate users from email case mismatch | Normalize all emails to lowercase before any INSERT or comparison |
| Next.js App Router + cmdk | Hydration mismatch from server-rendering a DOM-only library | `dynamic(() => import('./command-palette'), { ssr: false })` |
| Next.js App Router + search params | `useSearchParams()` without Suspense boundary causes build error | Wrap every `useSearchParams()` consumer in `<Suspense fallback={null}>` |
| WebSocket + notification badge | Badge initialized at 0 on every page load | Initialize badge from REST on mount; WS only delta-updates |
| WebSocket + multi-tab | Same event causes duplicate toasts and double badge increment | Deduplicate by notification ID using BroadcastChannel across tabs |

---

## Milestone Addendum: Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Badge count starts at 0 on page load | Activity notifications phase | Refresh page with 5 unread notifications; badge shows 5 immediately |
| Multi-tab duplicate notifications | Activity notifications phase | Open two tabs; receive one notification; badge shows 1 in both tabs, one toast total |
| Missed events during WS reconnect gap | Activity notifications phase | Disconnect WS, emit 3 events server-side, reconnect; all 3 appear in feed |
| OAuth duplicate users from email case mismatch | OAuth integration phase | Attempt OAuth sign-in where provider returns capitalized email; no duplicate account created |
| OAuth account takeover via unverified email | OAuth integration phase | Mock unverified-email OAuth token; assert linking is rejected |
| OAuth-first users cannot add password | OAuth integration phase | Sign up via Google; navigate to settings and successfully set a password |
| Onboarding wizard staleness | Onboarding phase | Move a UI element referenced in wizard; wizard still works or has an update flag |
| Onboarding gates before value | Onboarding phase | Measure time from signup to first machine data visible; must be under 5 minutes |
| Fixed-width horizontal overflow on mobile | Responsive layout phase | Test at 375px viewport; no horizontal scrollbar |
| Mobile sidebar inaccessible | Responsive layout phase | Test at 375px; hamburger toggle opens sidebar; all nav items reachable |
| Hydration mismatch on command palette | Search phase | `next build && next start`; no hydration errors in console |
| Stale search results during WS updates | Search phase | Receive WS update while typing in search; results update without resetting the search term |

---

*Addendum for: GSD Cloud Milestone 2 — activity notifications, onboarding, responsive layout, search, OAuth*
*Researched: 2026-06-22*


---

## Milestone Addendum: Email Notifications, Daily Digest, Admin Panel, Impersonation, and Feature Flags

**Added:** 2026-06-28
**Scope:** Common mistakes when ADDING email notification preferences, digest jobs, admin panel metrics, user management, impersonation, feature flags, and billing overrides to the existing GSD Cloud Next.js 16 + React 19 platform.
**Stack context:** Resend already used for transactional email; activity events via SSE; Better Auth with admin plugin; Neon Postgres serverless; no long-running connections for cron.
**Confidence:** MEDIUM — sourced from Better Auth official docs, Resend docs, cross-checked with web community knowledge on RFC 8058, CAN-SPAM, GDPR, feature flag post-mortems, and known CVEs in admin impersonation tools.

---

### Pitfall 25: Resend Does Not Manage Opt-Out Lists for Transactional Email — You Must

**What goes wrong:**
The team assumes Resend handles email opt-outs the way a marketing platform does. A user clicks unsubscribe; Resend records it; subsequent sends are automatically suppressed. This is not true for transactional emails sent via Resend's API. Resend only auto-suppresses bounced addresses for list-based (marketing) sends. Transactional API sends have no built-in suppression list. Emails keep going to users who unsubscribed, leading to spam reports, deliverability damage, and CAN-SPAM violations.

**Why it happens:**
Resend's marketing product (broadcast/lists) does manage suppression. Developers conflate the two products. The Resend dashboard has a "Contacts" feature but it does not auto-filter transactional API calls.

**How to avoid:**
- Maintain an `email_preferences` table in your own database with per-user, per-category opt-out columns.
- Before every send (including digest and alert emails), query `email_preferences` to verify the user has not opted out of that category.
- On receiving a Resend bounce webhook event, mark that address as suppressed in your `email_preferences` table and stop all sends to it immediately.
- On receiving a Resend complaint (spam report) webhook event, mark the user as globally opted out and suppress all non-transactional sends. Hard bounces must permanently suppress; soft bounces after 3 attempts should suppress temporarily.

**Warning signs:**
- Resend "Suppression list" in the dashboard is empty even though users have clicked unsubscribe.
- The codebase sends email via `resend.emails.send()` without querying `email_preferences` first.
- No webhook handler exists for Resend bounce or complaint events.

**Phase to address:**
Email notification preferences phase. The opt-out infrastructure must be in place before any preference UI is built.

---

### Pitfall 26: RFC 8058 One-Click Unsubscribe Missing — Gmail/Yahoo Will Block Bulk Sends

**What goes wrong:**
The daily digest is sent to all users who opted in. As volume grows past 5,000 messages/day to Gmail or Yahoo, those providers check for RFC 8058 compliance: a `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header and a POST endpoint that processes unsubscribes within 48 hours. Missing this causes delivery to the spam folder or outright rejection. The team notices open rates collapsing with no apparent code change.

**Why it happens:**
RFC 8058 became a hard requirement for bulk senders in February 2024. Teams that built email features before that date — or that copied older tutorials — do not include the header. The requirement is subtle: the `List-Unsubscribe` URL header alone (RFC 2369) is insufficient; the POST variant is now also required.

**How to avoid:**
- All digest and notification emails must include both headers:
  - `List-Unsubscribe: <https://yourapp.com/api/email/unsubscribe?token=...>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- The POST endpoint at that URL must honor the request and stop sending the relevant email category within 48 hours.
- The unsubscribe token must be per-user and per-category, not a shared or guessable value.
- Test by sending to a Gmail test account and checking if the "Unsubscribe" option appears directly in the Gmail UI (not just in headers) — that confirms RFC 8058 compliance.

**Warning signs:**
- Resend send calls do not set `headers` with `List-Unsubscribe-Post`.
- No POST route exists at the unsubscribe URL.
- Unsubscribe token is a bare user ID rather than a HMAC-signed value.

**Phase to address:**
Email notification preferences phase, before digest sends reach meaningful volume.

---

### Pitfall 27: Resend Webhook Events Are At-Least-Once — No Deduplication Causes Double Opt-Outs and Double Processing

**What goes wrong:**
Resend delivers webhooks with at-least-once semantics. A bounce event for a user arrives twice (network retry after a slow response). The webhook handler processes both: the first call marks the user as suppressed and records the event; the second call hits a now-suppressed account and attempts to mark it again — or worse, double-counts the bounce, hitting rate limits or corrupting metrics. The handler returns 200 on both but processes twice because there is no idempotency check.

**Why it happens:**
At-least-once delivery is standard for webhook systems. Developers write the handler for the happy path and do not account for duplicate delivery.

**How to avoid:**
- Every Resend webhook payload contains a `svix-id` header (Resend uses Svix for webhook delivery). Store processed `svix-id` values in a `processed_webhook_events` table with a UNIQUE constraint.
- On receipt: `INSERT INTO processed_webhook_events (svix_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`. If no row returned, the event was already processed — return 200 immediately without re-processing.
- If events arrive out of order (a complaint arrives before a delivery confirmation), use the `created_at` timestamp in the payload to resolve state; do not assume arrival order equals event order.
- The webhook endpoint must return HTTP 200 specifically — any non-200 triggers Resend's retry logic and amplifies duplicates.

**Warning signs:**
- No `processed_webhook_events` table exists.
- Webhook handler uses `svix-id` only for logging, not for deduplication.
- Webhook handler can be called twice with the same payload and updates the database twice.

**Phase to address:**
Email notification preferences phase. Webhook deduplication must be in place before any bounce/complaint handling goes live.

---

### Pitfall 28: Daily Digest Cron Job on Neon Serverless — pg_cron Is Not Supported

**What goes wrong:**
The team plans to use `pg_cron` to schedule the daily digest job inside the Neon database. `pg_cron` requires a persistent background worker process, which Neon's serverless (scale-to-zero) architecture does not support. The extension cannot be installed on Neon. Discovery of this comes during the digest implementation phase, requiring a redesign to use an external scheduler.

**Why it happens:**
`pg_cron` is the canonical Postgres scheduling extension. Teams accustomed to managed Postgres (RDS, Supabase) expect it to be available everywhere. Neon's docs mention the limitation but it is easy to miss.

**How to avoid:**
- Use an external cron scheduler: Vercel Cron Jobs (if hosting on Vercel), GitHub Actions scheduled workflows (free, reliable for daily jobs), or QStash (Upstash) for HTTP-based queue/scheduling. All three survive Neon's scale-to-zero because they trigger HTTP calls to your Next.js route handlers.
- The digest job architecture: external cron → POST to `/api/cron/digest` (Next.js route handler) → query Neon with pooled connection → call Resend → return 200.
- Protect the cron endpoint: verify a secret header (`Authorization: Bearer $CRON_SECRET`) that only the scheduler knows. Do not expose it publicly.
- Use Neon's pooled connection URL (`-pooler` hostname) for the digest query — this is especially critical for a short-lived invocation that cannot keep a connection alive.

**Warning signs:**
- Database migration attempts to run `CREATE EXTENSION pg_cron` — this will fail on Neon.
- Digest job architecture diagram shows a Postgres trigger or database-level scheduler.
- The cron endpoint has no authentication check.

**Phase to address:**
Email digest phase. Architecture decision (external cron) must be made before any digest scheduler code is written.

---

### Pitfall 29: Digest Job Opens Too Many Neon Connections — Exhausts Connection Pool

**What goes wrong:**
The digest job iterates over N users, opening a database connection per user to fetch their activity summary. With 10,000 users, this creates 10,000 concurrent connections to Neon. PgBouncer's transaction mode pools these to a finite number of Postgres connections, but the burst of 10,000 simultaneous client connections from the digest job starves connections from the live app, causing query timeouts for users browsing the dashboard during the digest run.

**Why it happens:**
The digest is written as a simple loop that is correct at small scale: `for (const user of users) { const data = await db.query(...); }`. Await-in-loop processes users sequentially, but if later optimized with `Promise.all()`, it fires all queries simultaneously.

**How to avoid:**
- Use a batched approach: process users in chunks of 50-100 at a time using `Promise.all()` on each chunk, then await the chunk before processing the next. This bounds concurrent DB connections.
- Use a single broad query to fetch all needed data in one statement, then process in memory: `SELECT user_id, ... FROM activity WHERE created_at > $1 GROUP BY user_id`. Avoid per-user queries.
- Always use the pooled Neon connection URL for the digest job — the `-pooler` hostname routes through PgBouncer and limits actual Postgres connections.
- Do not use `Promise.all(users.map(u => processUser(u)))` without a concurrency limiter (e.g., `p-limit` with concurrency of 10).

**Warning signs:**
- Digest loop uses `await` inside a `for...of` loop on every user without batching.
- The digest job uses a non-pooled connection URL.
- App query latency spikes during the digest run window.

**Phase to address:**
Email digest phase. Batching and connection pooling strategy must be in the design, not retrofitted after load testing.

---

### Pitfall 30: Admin Impersonation Audit Trail Records the Victim's Identity, Not the Admin's

**What goes wrong:**
An admin impersonates user Alice to debug a support ticket. All actions taken during the impersonation session are recorded in application logs as "Alice did X." When Alice later files a GDPR data subject request or a compliance audit is run, the logs show Alice deleting her own projects — but she was offline at that time. The audit trail is corrupted. The organization cannot demonstrate to auditors who actually made the changes. This is a SOC 2 finding and a GDPR compliance violation.

**Why it happens:**
Better Auth's admin plugin stores an `impersonatedBy` field in the session object, but the default application logging middleware does not read it. Logs emit the session's `userId` (Alice), not the `impersonatedBy` value (the admin). Better Auth provides no built-in audit log for impersonation events — it must be wired manually.

**How to avoid:**
- Wire a middleware that reads `session.impersonatedBy` on every request. If present, log the action as: `{ actor: adminUserId, actingAs: userId, action: "...", timestamp: ... }`. Never log it as just `userId`.
- Write impersonation start/stop events to a dedicated `impersonation_audit_log` table with columns: `admin_user_id`, `target_user_id`, `started_at`, `ended_at`, `reason`, `ip_address`, `session_id`.
- This table must be immutable (no UPDATE or DELETE) and accessible only to security/compliance roles, not to all admin panel users.
- Expose impersonation history to the target user on their account activity page: "Your account was accessed by support on [date] for [reason]."

**Warning signs:**
- Application logs use `session.userId` without checking `session.impersonatedBy`.
- No `impersonation_audit_log` table exists in the schema.
- Impersonation history is not visible to the affected user.
- Better Auth's `admin.impersonateUser()` is called without a surrounding audit log write.

**Phase to address:**
Admin panel phase (user management and impersonation). Audit logging is a security requirement, not a polish item — it must ship with the feature.

---

### Pitfall 31: Better Auth Admin Plugin — checkRolePermission Is Client-Side Only

**What goes wrong:**
The admin panel uses `authClient.admin.checkRolePermission()` on the client to show/hide UI elements based on the admin's role. The server-side API routes for admin actions (ban user, delete project, override billing) do not perform their own role check — they rely on the client-side check to have prevented unauthorized access. An attacker crafts a direct HTTP request to `/api/admin/ban-user` without going through the UI. The client-side check never runs. The server executes the ban without verifying the caller has permission.

**Why it happens:**
`checkRolePermission` is prominently documented as the way to check permissions, and it feels natural to use it in the middleware or route handler. The documentation does not prominently warn that it is client-only. The distinction between client-side visibility control and server-side authorization enforcement is conflated.

**How to avoid:**
- Never use `checkRolePermission` in server-side code for authorization decisions.
- On every admin API route, call `auth.api.getSession()` server-side, extract the user's roles, and verify the required permission using the server-side access control check (or a plain role string comparison against the allowed roles for that action).
- Use Better Auth's `adminAc` access control object on the server: `adminAc.roles[role].authorize({ [action]: true })` — this is the server-safe check.
- Apply a role-checking middleware to all `/api/admin/*` routes that runs before any route handler.

**Warning signs:**
- `/api/admin/*` routes use `checkRolePermission` imported from the client auth instance.
- A test making a raw HTTP request to an admin endpoint succeeds without a valid admin session.
- Admin permission checks exist only in React component conditionals, not in route handlers.

**Phase to address:**
Admin panel phase. Server-side authorization must be implemented on every admin route before the admin panel is accessible to any user.

---

### Pitfall 32: Custom Admin Roles Override All Default Permissions — Must Merge Explicitly

**What goes wrong:**
The team adds a custom `support` role to the Better Auth admin plugin with limited permissions: can view users and reset passwords, but not ban or delete. The custom role is defined as a new `adminAc.newRole(...)` call. However, it replaces the default admin role configuration entirely, stripping all built-in permissions including the ability to impersonate users (which `support` was supposed to have). Support staff find they cannot perform basic operations that were never explicitly added to the custom role.

**Why it happens:**
Better Auth's custom roles replace `defaultStatements` entirely rather than extending them. The documentation notes this but it is a non-obvious "gotcha." Developers assume adding a new role is additive.

**How to avoid:**
- When defining a custom role, explicitly merge `defaultStatements` and `adminAc.statements` into the new role's statement array:
  ```ts
  const supportRole = adminAc.newRole({
    statements: [
      ...defaultStatements,  // explicitly include base permissions
      { [permission.viewUsers]: ["view"] },
      { [permission.impersonateUser]: ["impersonate"] },
    ]
  });
  ```
- After defining any custom role, write a test that calls every admin action the role should and should not be able to perform, verifying the actual server-side authorization result.
- Document which permissions each role has in code comments adjacent to the role definition.

**Warning signs:**
- Custom role definition does not spread `defaultStatements`.
- Support staff report permission errors for operations they were supposed to have.
- Role definition tests check only the custom permissions, not the inherited base permissions.

**Phase to address:**
Admin panel phase (role configuration). Roles must be tested end-to-end before any access is granted to non-engineer admins.

---

### Pitfall 33: Impersonation Session Lives 1 Hour With No Task-Scoped Close

**What goes wrong:**
An admin impersonates a user to debug a billing issue. The issue is resolved in 3 minutes. The admin closes the browser tab without explicitly ending the impersonation session. The session remains active in the database for the full 1-hour default TTL. If the admin's machine is compromised during that window (unlocked laptop, shared session), the attacker has a live impersonation session for an arbitrary user. The admin also appears "online" as that user for the full hour, which can confuse presence indicators.

**Why it happens:**
Better Auth's impersonation session has a 1-hour TTL by default. There is no "end impersonation" button in the default implementation. The admin assumes closing the tab ends the session — it does not; the session persists in the database until expiry.

**How to avoid:**
- Implement an explicit "End impersonation" button that calls `authClient.admin.stopImpersonating()` and redirects to the admin panel.
- On the server, expose a `DELETE /api/admin/impersonation` endpoint that calls `auth.api.revokeSession()` for the impersonation session.
- Set a shorter TTL for impersonation sessions (15 minutes is reasonable) and add a server-side check: if a session has `impersonatedBy` set and was created more than 15 minutes ago, force-expire it.
- Log every `stopImpersonating` call (explicit close) and every session expiry for impersonation sessions in the audit log.
- Consider requiring re-authentication (step-up auth) before starting an impersonation session for high-privilege users.

**Warning signs:**
- No "End impersonation" button exists in the admin UI.
- Impersonation sessions have the same TTL as regular user sessions.
- `stopImpersonating()` is never called in the codebase.
- The impersonation audit log has no `ended_at` field.

**Phase to address:**
Admin panel phase (impersonation). Explicit session close and short TTL must ship with the impersonation feature, not as a follow-up.

---

### Pitfall 34: Feature Flag Reuse — Old Toggle Reactivated in New Code Path

**What goes wrong:**
A feature flag `enable_digest_emails` was created during the digest MVP and evaluated to `false` (off). Later, a developer working on a refactor uses the same flag name for a new but related feature (redesigned digest template). The flag is still `false` in the database. The new feature appears broken in production from day one because the flag never evaluates to `true`. The developer spends hours debugging why the new code never runs, eventually discovering the pre-existing flag value. In the worst case (the Knight Capital scenario), the old flag evaluates to `true` in production and activates unintended legacy behavior.

**Why it happens:**
Flags feel reusable because their names are semantically similar. Flag databases accumulate stale entries with no clear ownership or expiration, making it tempting to reuse rather than create a new flag.

**How to avoid:**
- Each feature flag is created once for one purpose and deleted when that purpose is complete. Never repurpose a flag.
- Treat flag names as immutable once deployed: if you need a new behavior, create `enable_digest_emails_v2`.
- Every flag must have an owner (developer or team) and an expiration date set at creation time. Expired flags are deleted, not reused.
- Add a flag registry in the admin panel: name, owner, created date, planned expiration, flag type (release/ops/experiment/permission). Flags without an owner are a warning sign.

**Warning signs:**
- Feature flag names include version numbers or qualifiers added after the fact (suggests the original was repurposed).
- No owner or expiration metadata on any flag entry.
- Developers search for existing flags before creating a new one (a good instinct, but can lead to reuse).

**Phase to address:**
Feature flags phase. Flag lifecycle governance must be defined at the time flags are first introduced, not after the first "orphan flag" incident.

---

### Pitfall 35: Feature Flags Without Kill Switch Default Behavior — Enabled When Service Is Down

**What goes wrong:**
The feature flag service (database query, remote config API, or custom implementation) fails. The flag evaluation code throws an exception or returns `null`. The application catches the error and defaults to `true` ("fail open") because that was the easiest path to write. All features are now enabled for all users, including features that were in controlled rollout to 5% of users. A partially-completed feature ships to 100% of users, causing data corruption or a degraded experience.

**Why it happens:**
"Fail open" is chosen because the developer is thinking about the case where the flag service is down during a new feature rollout (they don't want to roll back a good feature because of a flag service blip). The dangerous corollary — that fail-open also enables unfinished features — is not considered.

**How to avoid:**
- Flag evaluation must default to `false` (off) on any error, exception, timeout, or null response. This is the safe default for all release flags.
- Ops/kill-switch flags must also default to `false` (feature is on when flag is explicitly `true`, off on any evaluation failure).
- Wrap all flag evaluation in a try-catch that returns the safe default:
  ```ts
  function getFlag(name: string): boolean {
    try {
      return flagStore.get(name) ?? false;
    } catch {
      return false; // safe default
    }
  }
  ```
- Test the failure case explicitly: drop the flags table, verify the app still runs with all features in their safe (off) state.

**Warning signs:**
- Flag evaluation code has `catch (e) { return true; }` or `?? true`.
- No test covers the case where the flag store is unavailable.
- Some flags have no documented "safe default" (what should the behavior be if the flag cannot be read?).

**Phase to address:**
Feature flags phase. Safe-default evaluation logic must be in place before any flag is used in production code.

---

### Pitfall 36: Daily Digest Is Marketing Email Under GDPR — Signup Consent Is Not Enough

**What goes wrong:**
Users sign up for GSD Cloud. The terms of service mention "we may send you emails." The daily activity digest is enabled by default for all users. European users receive digests without having given specific, granular consent for marketing emails. A GDPR complaint is filed. The team argues the digest is "transactional" (service notification). Regulators disagree — a daily summary of activity is a service newsletter, not a transaction confirmation. The team must retroactively obtain consent from all EU users and disable digest emails for those who do not respond, losing a significant portion of the engaged user base.

**Why it happens:**
"Transactional" is defined loosely internally. Teams classify notification emails as transactional to avoid the consent burden. GDPR defines transactional email narrowly: it must be directly triggered by a specific user action (password reset, purchase confirmation). A periodic digest summarizing activity is not transactional under GDPR.

**How to avoid:**
- Classify emails correctly: password reset, device pairing confirmation, billing receipt = transactional. Daily digest, weekly summary, product update = marketing/newsletter.
- For marketing emails: require explicit opt-in (not pre-checked, not inferred from account creation). Store the consent timestamp and mechanism (e.g., "user checked opt-in box on profile page on 2026-06-28").
- The daily digest must be opt-in, not opt-out, for EU users. Default to off, and prompt users to enable it during onboarding.
- Do not add promotional content to transactional emails — a password reset email with a "Check out new features" banner can reclassify it as marketing.

**Warning signs:**
- Daily digest is enabled by default with no explicit consent capture.
- No distinction in the codebase or database between transactional and marketing email categories.
- `email_preferences` table has a single `email_enabled` boolean rather than per-category columns.

**Phase to address:**
Email notification preferences phase. Email classification and consent capture must be in the data model from the start.

---

### Pitfall 37: Admin Panel IDOR — User Actions Bypass Tenant Scope via Direct ID Manipulation

**What goes wrong:**
The admin panel has a "View user" page at `/admin/users/[userId]`. The admin API route at `GET /api/admin/users/[userId]` fetches the user record by ID. An admin at one organization who has access to the admin panel can change the `userId` parameter in the URL to fetch another organization's user data. The route does no tenant-scoping check — it treats any admin as having access to any user in the system. In a multi-tenant SaaS where different admins should only see their own organization's users, this is a privilege escalation.

**Why it happens:**
Admin routes are assumed to be "trusted" because they require admin role. The distinction between "admin of my org" and "super-admin of all orgs" is not enforced at the route level. The route handler validates the admin role but not the scope of that admin's authority.

**How to avoid:**
- Every admin API route must assert that the resource being accessed belongs to the authenticated admin's organization scope.
- For super-admin routes (accessing any user in the system), require an explicit `SUPER_ADMIN` role separate from the regular `admin` role.
- Add a middleware that enforces: `if (requestedUser.organizationId !== adminUser.organizationId) return 403`.
- Test with two distinct organizations: an admin from Org A cannot access users from Org B via URL manipulation.

**Warning signs:**
- Admin API routes validate the `admin` role but not the organizational scope of the request.
- No `organizationId` filter on admin user-fetch queries.
- A single `admin` role grants access to all users in the system regardless of organization.

**Phase to address:**
Admin panel phase. Tenant-scoped authorization must be implemented on all admin routes before the admin panel is accessible to any non-super-admin.

---

### Pitfall 38: Billing Override Without Audit Trail Creates Untracked Liability

**What goes wrong:**
The admin panel includes a "Billing override" feature: admins can extend a trial, grant free months, or change a user's plan tier without going through Stripe. An override is applied without an audit record. A month later, the company is audited for revenue recognition. A user is on the paid plan in the application but has no Stripe subscription — the override is invisible to finance. The billing database and Stripe are out of sync. The override mechanism also becomes a vector for insider abuse: admins grant themselves or friends free access with no trace.

**Why it happens:**
Billing overrides are added as a quick customer success tool. The Stripe integration is bypassed "just for this one case." No one thinks to log the override because it feels like an internal tool, not a financial transaction.

**How to avoid:**
- Every billing override must write to an `admin_billing_overrides` table: `admin_user_id`, `target_user_id`, `override_type`, `original_value`, `new_value`, `reason` (required text field), `applied_at`, `expires_at`.
- Require a `reason` string for every override — it cannot be empty. This creates accountability without a full approval workflow.
- Overrides must have an expiry date — no permanent "free forever" grants without explicit super-admin approval.
- Display override history to finance/super-admin in a dedicated view.
- Consider syncing overrides to a Stripe coupon or metadata field so billing reports stay reconcilable.

**Warning signs:**
- Billing override API has no corresponding write to an audit table.
- `reason` field for overrides is optional or absent.
- No expiry date on billing overrides.
- Finance cannot enumerate all active billing overrides from the database.

**Phase to address:**
Admin panel phase (billing overrides). The audit trail must be part of the override feature schema, not added later.

---

## Milestone Addendum 3: Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Resend transactional sends | Assuming Resend auto-suppresses opted-out users | Maintain your own `email_preferences` table; check opt-out before every send |
| Resend webhooks | No deduplication on bounce/complaint events | Deduplicate by `svix-id` header with UNIQUE constraint in `processed_webhook_events` |
| Resend webhooks | Returning non-200 on slow processing | Return 200 immediately; process asynchronously; any non-200 triggers retries |
| Neon + digest cron | Attempting to use `pg_cron` extension | Use external scheduler (Vercel Cron, GitHub Actions, QStash) triggering HTTP route |
| Neon + digest job | Direct TCP connections from each user iteration | Use pooled URL (`-pooler`); batch queries; use single broad GROUP BY query |
| Better Auth admin | Using `checkRolePermission` in server route handlers | Server-side only: use `adminAc.roles[role].authorize()` or session role check |
| Better Auth admin | Custom roles defined without spreading `defaultStatements` | Explicitly merge `...defaultStatements` into custom role statement array |
| Better Auth impersonation | No audit log for impersonation start/stop | Write to `impersonation_audit_log` table on every `impersonateUser()` and `stopImpersonating()` call |
| Feature flags + Neon | Flag evaluation defaults to `true` on DB error | Catch all errors in flag evaluation; return `false` as safe default |

---

## Milestone Addendum 3: Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Digest job per-user DB query | App query latency spikes during digest window; connection pool exhausted | Single broad GROUP BY query; batch with `p-limit` concurrency ≤ 10 | ~1,000 users receiving digest |
| Flag evaluation on every request with DB lookup | Noticeable latency increase on all page loads | Cache flag values in-memory with 30-second TTL; invalidate on admin panel flag change | ~100 req/s |
| Admin panel user list without pagination | Admin user list page hangs with 10k+ users | Always paginate; default to 25 users per page; add cursor-based pagination for export | ~5,000 users |
| Sending digest emails in a single Resend batch call | Single API call with thousands of recipients; Resend rate limit hit | Use Resend's batch send API with max batch size per call; add delay between batches | ~500 recipients in one call |

---

## Milestone Addendum 3: Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Impersonation logs record victim's ID as actor | SOC 2 finding, GDPR violation, unusable audit trail | Middleware reads `session.impersonatedBy`; logs emit both admin ID and target user ID |
| Admin IDOR via URL userId manipulation | Admin accesses users outside their org scope | Assert `requestedResource.orgId === adminUser.orgId` on every admin route |
| Billing override with no audit trail | Revenue recognition failure, insider abuse | `admin_billing_overrides` table with required `reason`, mandatory `expires_at` |
| Unsubscribe token is plain userId | Any user can unsubscribe any other user | HMAC-signed token: `HMAC(secret, userId + emailCategory + date)` |
| Digest cron endpoint has no auth | Anyone can trigger expensive digest send | Verify `Authorization: Bearer $CRON_SECRET` header before executing |
| Feature flag admin UI accessible to all admin roles | Non-technical admin toggles wrong flag | Feature flag management restricted to `SUPER_ADMIN` role; regular admins read-only |

---

## Milestone Addendum 3: "Looks Done But Isn't" Checklist

- [ ] **Resend opt-out sync:** Bounce and complaint webhook events update `email_preferences` suppression flag — verify by simulating a bounce event and confirming subsequent sends to that address are blocked before reaching Resend.
- [ ] **RFC 8058 compliance:** `List-Unsubscribe-Post` header is present on all digest emails — verify by inspecting raw email headers in a Gmail test account.
- [ ] **Webhook deduplication:** Replaying the same Resend webhook event twice produces exactly one DB write — verify by calling the webhook endpoint with the same `svix-id` twice and checking the `processed_webhook_events` count.
- [ ] **pg_cron not used:** Schema has no `pg_cron` extension — verify with `SELECT * FROM pg_extension WHERE extname = 'pg_cron'` returning no rows.
- [ ] **Impersonation audit log:** Every `admin.impersonateUser()` call writes to `impersonation_audit_log` — verify by impersonating a user and checking the table for the entry including `admin_user_id`, `target_user_id`, `started_at`.
- [ ] **Server-side admin role check:** A raw HTTP request to `/api/admin/ban-user` without an admin session returns 403 — verify with `curl` bypassing the UI.
- [ ] **Billing override audit:** Every billing override writes to `admin_billing_overrides` with a non-empty reason — verify by applying an override and checking the table.
- [ ] **Feature flag safe default:** With the flags table unavailable, all feature-gated code executes the `false` (off) branch — verify by mocking the flag store to throw and asserting the fallback behavior.
- [ ] **GDPR consent for digest:** EU users cannot receive digest emails without an explicit opt-in record in `email_preferences` — verify that a new EU user does not receive a digest until they explicitly opt in.

---

## Milestone Addendum 3: Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Resend no built-in suppression | Email notification preferences | New opt-out + subsequent send attempt = no email sent; Resend send never called |
| RFC 8058 missing one-click unsubscribe | Email notification preferences | `List-Unsubscribe-Post` header present in all digest email raw headers |
| Resend webhook duplicate processing | Email notification preferences | Same `svix-id` delivered twice = exactly one DB row in processed_webhook_events |
| pg_cron not supported on Neon | Email digest phase | No pg_cron extension in schema; external scheduler confirmed |
| Digest connection pool exhaustion | Email digest phase | Digest run with 1,000 users; app query latency unchanged during run |
| Impersonation audit trail corrupted | Admin panel phase | Impersonate a user; audit log shows admin_user_id, not impersonated user_id |
| checkRolePermission used server-side | Admin panel phase | Raw HTTP request to admin route without session returns 403 |
| Custom roles lose default permissions | Admin panel phase | Support role can impersonate (explicit); cannot delete (not granted); base permissions intact |
| Impersonation session 1hr no close | Admin panel phase | "End impersonation" button calls stopImpersonating(); session revoked immediately |
| Feature flag reuse | Feature flags phase | Each flag has owner + expiration in registry; no flag names reused |
| Feature flag fail-open on error | Feature flags phase | Flag store unavailable → all flags evaluate to false; verified by mocking DB failure |
| Daily digest = marketing email under GDPR | Email notification preferences | New user has digest disabled by default; explicit opt-in required before first digest send |
| Admin IDOR via userId param | Admin panel phase | Admin from Org A cannot fetch user from Org B; 403 returned |
| Billing override no audit trail | Admin panel phase | Override applied; `admin_billing_overrides` row written with reason and expires_at |

---

*Addendum for: GSD Cloud Milestone 3 — email notifications, daily digest, admin panel, impersonation, feature flags*
*Researched: 2026-06-28*
