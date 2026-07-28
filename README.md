# Unified Service Scheduler

Backend for booking vehicle service appointments at a dealership. A booking is confirmed
only when **both** a service bay **and** a technician qualified for the requested service are
free for the **entire** duration of the job.

Keyloop technical assessment, Scenario A. The client layer is deliberately out of scope and
is stubbed by the OpenAPI contract in [`docs/openapi.yaml`](docs/openapi.yaml) and the cURL
examples below.

---

## The one decision this project is about

Availability is a claim about the future that two callers can make at the same instant. The
gap between "I checked and it was free" and "I wrote the booking" is where every naive
implementation of this problem breaks — and a scheduler that is correct under sequential load
but double-books under parallel load has not solved the problem, it has moved the failure
somewhere harder to see.

So the non-overlap invariant is **not** enforced by application code. It is declared in the
schema:

```sql
ALTER TABLE appointments
  ADD CONSTRAINT no_bay_overlap
  EXCLUDE USING gist (service_bay_id WITH =, time_range WITH &&)
  WHERE (status = 'confirmed');

ALTER TABLE appointments
  ADD CONSTRAINT no_technician_overlap
  EXCLUDE USING gist (technician_id WITH =, time_range WITH &&)
  WHERE (status = 'confirmed');
```

The availability query that runs before the insert is **not** the safety net. It exists to
produce a useful rejection ("no qualified technician is free") instead of a bare constraint
violation. The division of labour is explicit:

- **Application layer** — answers *why* a booking cannot happen, in business language.
- **Database** — guarantees that it *does not* happen, under any concurrency.

Ten parallel requests for a slot with capacity for one, against a running server:

```
   1 201
   9 409
rows in appointments: 1
```

Full reasoning, the options that were rejected, and what building it revealed:
[`docs/system-design.md`](docs/system-design.md).

---

## Quick start

Requires **Node 22+**, **pnpm**, and **Docker** (Postgres, and Testcontainers for the
integration suite).

```bash
pnpm install
pnpm db:up        # Postgres 16 on localhost:55432
pnpm db:migrate
pnpm db:seed
pnpm start        # http://localhost:3000
```

`pnpm db:reset` does the whole cycle from a clean volume.

> The compose file binds **55432**, not 5432 — developers commonly already have a Postgres on
> the default port. Set `DATABASE_URL` to match:
> `postgresql://scheduler:scheduler@localhost:55432/scheduler`

| Script | Does |
| --- | --- |
| `pnpm start` / `pnpm dev` | Run the server (dev watches for changes) |
| `pnpm test` | Full suite — unit, integration, concurrency |
| `pnpm openapi` | Regenerate `docs/openapi.yaml` from the route schemas |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint, including the architectural import rule |
| `pnpm db:up` / `db:down` / `db:migrate` / `db:seed` / `db:reset` | Database lifecycle |

### Configuration

Parsed with Zod at startup and **fails fast** if invalid. See [`.env.example`](.env.example).

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | pino levels |
| `DB_POOL_MAX` | `10` | Sized below the database's own limit so the service degrades first |

---

## API

**Swagger UI is served by the app itself at <http://localhost:3000/swagger>** — same origin as
the API, so "Try it out" actually calls it. The raw document is at `/swagger/json` and
`/swagger/yaml`.

The contract is **generated from the route schemas, never hand-written**. Each route declares
a Zod schema that does three jobs at once: validate at the boundary, type the handler, and
produce the OpenAPI document. A hand-written spec drifts from the code silently and no test
would catch it; a generated one cannot. `pnpm openapi` writes it to
[`docs/openapi.yaml`](docs/openapi.yaml).

Every response echoes `x-correlation-id` — supplied by the client, or generated. One id
retrieves the whole story of a booking attempt from the logs.

All examples below were executed against a running server on seeded data; the responses are
copied from the actual output, not written by hand.

### Book an appointment

The client sends a **start time only**. The end is derived server-side from the service
type's duration, so a caller cannot understate a job to fit a gap.

```bash
curl -i -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -H 'x-correlation-id: demo-001' \
  -d '{
    "customerId":    "50000000-0000-0000-0000-000000000001",
    "vehicleId":     "60000000-0000-0000-0000-000000000001",
    "dealershipId":  "10000000-0000-0000-0000-000000000001",
    "serviceTypeId": "20000000-0000-0000-0000-000000000001",
    "startTime":     "2026-08-03T09:00:00Z"
  }'
```

```
HTTP/1.1 201 Created
x-correlation-id: demo-001
```
```json
{
  "id": "7c2e5200-c691-4171-82d6-205806b57e6c",
  "customerId": "50000000-0000-0000-0000-000000000001",
  "vehicleId": "60000000-0000-0000-0000-000000000001",
  "dealershipId": "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "technicianId": "40000000-0000-0000-0001-000000000003",
  "serviceBayId": "30000000-0000-0000-0001-000000000001",
  "startTime": "2026-08-03T09:00:00.000Z",
  "endTime": "2026-08-03T09:30:00.000Z",
  "status": "confirmed"
}
```

Oil Change is 30 minutes, so `endTime` is 09:30 — the client never sent it.

### Cancel — and watch the slot free itself

This is the sequence worth reading closely, because **no code releases the bay or the
technician**. Both exclusion constraints are scoped to `WHERE status = 'confirmed'`, so
flipping the status removes the row from their scope and the time becomes bookable again in
the same transaction.

That predicate was added in the *first* migration, months of feature-work before cancellation
existed, on the reasoning that it cost nothing then and would avoid a constraint rebuild on a
populated table later ([A-002](docs/assumptions.md)). This is that bet paying out.

```bash
# 1. Book the only gearbox slot London can staff
ID=$(curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":"50000000-0000-0000-0000-000000000001",
  "vehicleId":"60000000-0000-0000-0000-000000000001",
  "dealershipId":"10000000-0000-0000-0000-000000000001",
  "serviceTypeId":"20000000-0000-0000-0000-000000000006",
  "startTime":"2026-08-03T08:00:00Z"}' | jq -r .id)

# 2. The slot is now full
#    -> 409 NO_QUALIFIED_TECHNICIAN

# 3. Cancel it
curl -X DELETE "localhost:3000/appointments/$ID"

# 4. Book the same time again
#    -> 201 confirmed
```

Actual output of that run:

```
1) book the only gearbox slot   id=f2846f9d-452e-4be5-b549-707ae0d03b46
2) book the same time again  -> 409 NO_QUALIFIED_TECHNICIAN
3) cancel                    -> {"status":"cancelled"}
4) cancel again (idempotent) -> 200
5) book the same time again  -> 201 confirmed
6) unknown id                -> 404
```

The cancelled row is **kept, not deleted** — the schedule stays auditable. `DELETE` is
idempotent as HTTP requires (A-024), and an appointment whose service has already started
cannot be cancelled at all (422 `APPOINTMENT_ALREADY_STARTED`, A-023): once the car is on the
ramp, "cancelled" is the wrong word for what happened.

### Check availability

Advisory only: it reports what a booking *would* do without taking the slot. Between this
call and a subsequent booking another caller can take the last pair, which is exactly why the
booking path does not trust its own availability read either.

```bash
curl "localhost:3000/availability?\
dealershipId=10000000-0000-0000-0000-000000000001&\
serviceTypeId=20000000-0000-0000-0000-000000000001&\
startTime=2026-08-03T11:00:00Z"
```
```json
{"available":true,"startTime":"2026-08-03T11:00:00.000Z","endTime":"2026-08-03T11:30:00.000Z","freeBays":5,"freeQualifiedTechnicians":4,"reason":null}
```

### Every rejection path

Each is reachable by hand from the seed data — that is what the seed is shaped for.

<details>
<summary><b>400</b> — payload fails schema</summary>

```bash
curl -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001"}'
```
```json
{"error":{"code":"VALIDATION_FAILED","message":"Request failed schema validation","details":{"issues":[...]}}}
```
</details>

<details>
<summary><b>404</b> — referenced entity does not exist</summary>

```bash
# dealershipId that is not in the database
curl -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":"50000000-0000-0000-0000-000000000001",
  "vehicleId":"60000000-0000-0000-0000-000000000001",
  "dealershipId":"00000000-0000-0000-0000-0000000000ff",
  "serviceTypeId":"20000000-0000-0000-0000-000000000001",
  "startTime":"2026-08-03T09:00:00Z"}'
```
```json
{"error":{"code":"ENTITY_NOT_FOUND","message":"Dealership '00000000-0000-0000-0000-0000000000ff' does not exist","details":{"entity":"Dealership","id":"00000000-0000-0000-0000-0000000000ff"}}}
```
</details>

<details>
<summary><b>422</b> — before opening</summary>

London opens 08:00 local. `04:00Z` is 05:00 London in August (BST).

```bash
curl -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":"50000000-0000-0000-0000-000000000001",
  "vehicleId":"60000000-0000-0000-0000-000000000001",
  "dealershipId":"10000000-0000-0000-0000-000000000001",
  "serviceTypeId":"20000000-0000-0000-0000-000000000001",
  "startTime":"2026-08-03T04:00:00Z"}'
```
```json
{"error":{"code":"OUTSIDE_BUSINESS_HOURS","message":"Requested range falls outside business hours (before_opening)","details":{"reason":"before_opening"}}}
```
</details>

<details>
<summary><b>422</b> — a long service that would run past closing</summary>

Gearbox Rebuild is 240 minutes. Starting 16:30 London runs to 20:30, past the 18:00 close.

```bash
curl -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":"50000000-0000-0000-0000-000000000001",
  "vehicleId":"60000000-0000-0000-0000-000000000001",
  "dealershipId":"10000000-0000-0000-0000-000000000001",
  "serviceTypeId":"20000000-0000-0000-0000-000000000006",
  "startTime":"2026-08-03T15:30:00Z"}'
```
```json
{"error":{"code":"OUTSIDE_BUSINESS_HOURS","message":"Requested range falls outside business hours (after_closing)","details":{"reason":"after_closing"}}}
```
</details>

<details>
<summary><b>422</b> — booking in the past</summary>

```json
{"error":{"code":"BOOKING_IN_THE_PAST","message":"Appointments cannot be booked in the past","details":{"requestedStart":"2020-01-01T09:00:00.000Z"}}}
```
</details>

<details>
<summary><b>409</b> — no qualified technician</summary>

Manchester employs nobody who can rebuild a gearbox. The skill matrix has this gap on
purpose, so the rejection is reachable without first filling the calendar.

```bash
curl -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":"50000000-0000-0000-0000-000000000001",
  "vehicleId":"60000000-0000-0000-0000-000000000001",
  "dealershipId":"10000000-0000-0000-0000-000000000002",
  "serviceTypeId":"20000000-0000-0000-0000-000000000006",
  "startTime":"2026-08-03T09:00:00Z"}'
```
```json
{"error":{"code":"NO_QUALIFIED_TECHNICIAN","message":"No technician qualified for this service type is free for the entire requested range","bindingResource":"technician"}}
```

**Every 409 names the resource that was the binding constraint.** "Conflict" alone is not an
acceptable body — the ratio between `NO_BAY_AVAILABLE`, `NO_QUALIFIED_TECHNICIAN` and
`SLOT_ALREADY_TAKEN` is a real operational signal about contention.
</details>

### See the race for yourself

London employs exactly one technician qualified for a gearbox rebuild, so the slot's capacity
is one no matter how many bays are free.

```bash
BODY='{"customerId":"50000000-0000-0000-0000-000000000001",
       "vehicleId":"60000000-0000-0000-0000-000000000001",
       "dealershipId":"10000000-0000-0000-0000-000000000001",
       "serviceTypeId":"20000000-0000-0000-0000-000000000006",
       "startTime":"2026-08-03T08:00:00Z"}'

for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/appointments \
    -H 'content-type: application/json' -d "$BODY" &
done | sort | uniq -c
```
```
   1 201
   9 409
```

### Operations

```bash
curl localhost:3000/health        # {"status":"ok"}      liveness
curl localhost:3000/health/ready  # {"status":"ready"}   readiness (checks the database)
curl localhost:3000/metrics       # Prometheus exposition
```

Kept separate so an orchestrator restarts a wedged process but not a healthy one during a
brief database blip.

---

## Architecture

Feature-based Clean Architecture. Dependencies point **inward only**, and that rule is a lint
error rather than a review convention — `src/domain/**` cannot import from `application/`,
`infrastructure/` or `config/`.

```
src/
  domain/scheduling/       Pure business logic. No I/O. Unit-testable with no infrastructure.
    time-range.ts            Half-open [start, end) arithmetic — the heart of the system
    business-hours.ts        UTC instant → dealership wall clock, via Intl
    availability.ts          Qualification, freedom, and the selection policy
    entities.ts errors.ts ids.ts
  application/scheduling/  Use cases. Orchestration only — no SQL, no HTTP.
    book-appointment.ts  check-availability.ts  ports.ts
  infrastructure/          The only layer that knows about Postgres and HTTP.
    db/     client, schema, scheduling.repository, migrate, seed
    http/   app (routes + swagger), error-mapper, schemas (Zod), serialisers
    observability/  metrics, tracing
  config/env.ts            Zod-parsed environment, fails fast
migrations/                Forward-only, checked in
scripts/                   migrate, seed, generate-openapi
```

Three details worth knowing:

**Branded ids.** All seven identifiers are UUID strings, so the compiler would happily accept
a `TechnicianId` where a `ServiceBayId` belongs. Branding makes that a compile error instead
of a runtime mystery.

**Half-open ranges.** `[start, end)`. An appointment ending at 10:00 and one starting at 10:00
do **not** conflict. The database enforces the same semantic — a `CHECK` constraint rejects
any range stored with different bounds.

**All five invariants live in the schema, not the code.** Non-overlap uses the two `EXCLUDE`
constraints; qualification, duration, and same-dealership use *composite foreign keys*, so
they hold against a manual `INSERT` too. No triggers, no stored procedures.

| Invariant | Mechanism |
| --- | --- |
| No two appointments overlap in one bay | `EXCLUDE USING gist` |
| No two appointments overlap for one technician | `EXCLUDE USING gist` |
| The technician holds the required skill | `FK (technician_id, service_type_id) → technician_skills` |
| `end = start + service_type.duration` | generated column + `FK (service_type_id, duration_minutes)` |
| Technician and bay belong to the appointment's dealership | `FK (…, dealership_id) → technicians` / `service_bays` |

---

## Testing

```bash
pnpm test
```

112 tests. Shaped around the risk profile, not around a coverage percentage.

| Suite | What it proves |
| --- | --- |
| `tests/unit/` | Exhaustive boundary cases on time arithmetic — identical, touching, containment both ways, partial overlap both ways, zero-length rejection. Plus DST: the same 13:00 UTC is rejected on 7 March and accepted on 8 March in New York, which a hard-coded offset would fail. |
| `tests/integration/` | Every status in the error table, against real Postgres via Testcontainers — including the book → 409 → cancel → book-again sequence that proves a cancellation frees the slot with no compensating write |
| `tests/concurrency/` | **The important one.** 20 parallel `POST /appointments` into a slot with exactly one bay/technician pair: exactly one 201, nineteen 409s, and exactly one row in the table. Deterministic via `Promise.all` — no sleeps, no timing assumptions. |

No mocking of Postgres in the integration tests. A mocked repository cannot exercise an
exclusion constraint, so a mock-based suite would report full green coverage of the one thing
most likely to be wrong.

---

## Observability

Structured JSON via pino, logged at boundaries only — request in, request out, database
error, domain rejection — never inside loops. Customer names, emails, phone numbers and VINs
are redacted wherever they might appear.

`/metrics` exposes:

| Metric | Why it matters |
| --- | --- |
| `bookings_total{outcome,dealership_id}` | Rejection *rate* is the headline health signal |
| `cancellations_total{dealership_id}` | Cancellations return capacity, so a rising cancellation rate explains a falling rejection rate without any change in demand |
| `booking_rejections_total{reason}` | A spike in `SLOT_ALREADY_TAKEN` means contention is rising — a different response from a spike in `NO_QUALIFIED_TECHNICIAN` |
| `booking_duration_seconds` | p99 including the transaction |
| `availability_query_duration_seconds` | First thing to degrade as the table grows |

Cardinality is controlled deliberately: `dealership_id` is a bounded set, but `technician_id`
and `customer_id` are not, and are never label values.

OpenTelemetry is wired with a **console exporter only**, creating spans at three boundaries —
`book_appointment`, `availability.free_bays` / `availability.free_technicians`, and
`appointment.insert`. Pointing the exporter at a collector is described in the design document
rather than built; the span boundaries are the part that matters, and they are real.

---

## AI Collaboration Narrative — implementation phase

> The design-phase narrative is in [`docs/system-design.md`](docs/system-design.md) §11. This
> section covers what happened while writing the code.

The working rule was that AI could produce code but could not certify it. Nothing was
recorded as working until it had been executed — and that distinction turned out to be the
entire value of the exercise, because the two most interesting defects in this repository
were invisible to reading and only appeared under load.

### The governance artifact did the heavy lifting

`CLAUDE.md` was written before any code and encodes the architecture, the invariants, the
testing requirements, and an explicit list of changes requiring approval — locking strategy,
schema, dependencies. It was load-bearing in practice, not decorative: it is what made the
model stop and ask before touching `migrations/`, and what made "did the output honour the
document?" a reviewable question instead of re-deriving intent from a diff. That is the
scaled version of the verification problem, and the pattern I would bring to a team.

### Two defects that only running the code could find

**Deterministic selection caused a thundering herd.** The selection policy broke ties on
lowest id, chosen for testability. Under parallel load every concurrent request then computed
the *same* lowest-id pair, collided on the exclusion constraint, and only one survived — a
slot with capacity for four filled one of it. The system was never incorrect; it was
starving. Measuring each candidate fix over ten runs mattered, because a single sample lied:
bounded re-selection alone read as "3 of 4" on the first run but averaged 2.6 across ten. A
random tiebreak plus bounded re-selection reached 4 of 4 in twenty consecutive runs.
(Assumptions A-014, A-015, A-021.)

**The exclusion constraint can deadlock, not only reject.** Concurrent inserts of overlapping
ranges take gist-index locks in an order Postgres sometimes resolves by aborting one
transaction with SQLSTATE `40P01`, rather than the clean `23P01` the design anticipated. Left
unhandled it escaped as an HTTP 500 — found by the concurrency test on its first real run. A
deadlock victim has not necessarily lost the slot, so it is retried on a fresh transaction and
reaches the client as a 409 only if every retry also deadlocks. Over 320 concurrent requests
after the fix, none escaped. (Assumption A-022.)

Both corrections are recorded in `docs/system-design.md` §5.5, including the correction that
the design's original claim of "no retry loops" is no longer true. The gap between a design
and its measured behaviour is the part worth writing down.

### Where verification caught the model, not the code

Several claims were wrong on the first attempt and were only caught by executing them: a
schema decision that silently made service-type durations immutable once booked (found by
trying the `UPDATE`, recorded as A-019); Zod's `uuid()` rejecting the seeded identifiers
because they carry no RFC version nibble (found because every request returned 400); a
diagram that rendered locally but not in the reviewer's Markdown viewer, fixed only after
asking for the actual error instead of guessing twice more. Each is a case where a plausible
explanation would have been wrong.

### The failure the tests could not see

The most instructive miss was not caught by any test, because no test could have been.

`CLAUDE.md` §2 specifies the API contract as *"OpenAPI 3.1, generated from Fastify schemas"*.
The HTTP layer was built with Zod `.parse()` calls **inside** the handlers instead of schemas
declared on the routes — so there were no Fastify schemas to generate from, and the spec was
written by hand. Everything passed: 100 tests, typecheck, lint, and a spec that validated
cleanly against Redocly. The deviation was silent because the artifact *looked* correct.

It surfaced only when someone asked why Swagger was not served at `/swagger` — a question
about developer experience that turned out to be a question about compliance. The proper fix
moved the Zod schemas onto the routes, which closed four gaps at once: the contract became
generated, validation moved to the actual boundary, the docs became same-origin so "Try it
out" works, and the response shapes became compiler-enforced. That last one was immediate:
`tsc` failed on two serialisers typed as `string` where the schema required a specific union
— a mismatch that had existed unnoticed while the spec was hand-written.

The lesson I take is about what a green build proves. Tests verify behaviour against
expectations; they cannot verify that the implementation honoured its governing document.
That check is a reading task, and I did not do it at the point where it mattered — when
hand-writing an artifact the document said should be generated. Where a constraint is
mechanically checkable, it should be a build step, not a paragraph.

### Where AI was deliberately not used

The half-open range semantics, the decision to put the invariant in the database rather than
the application, and the division of labour in §5.3 were reasoned through on paper first.
These are the load-bearing decisions, and I wanted to defend them from first principles rather
than recognise them as correct after the fact.

---

## Documents

| | |
| --- | --- |
| [`docs/system-design.md`](docs/system-design.md) | Architecture, the concurrency problem, options rejected, what building it revealed |
| [`docs/assumptions.md`](docs/assumptions.md) | 22 assumptions, each with rationale, cost of reversal, and confidence |
| [`docs/openapi.yaml`](docs/openapi.yaml) | OpenAPI 3.1 contract — generated by `pnpm openapi`, browsable at `/swagger` |
| [`CLAUDE.md`](CLAUDE.md) | The constraint document governing AI-assisted development here |

## Known limitations

Documented honestly rather than discovered later: no idempotency key on booking (A-016);
business hours are a single window per dealership with no holiday calendar (A-007, the weakest
assumption in the register); one technician per appointment is structurally expensive to
reverse (A-010); a service type's duration cannot change while appointments reference it
(A-019); no authentication, cancellation, or rate limiting.
