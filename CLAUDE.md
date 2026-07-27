# CLAUDE.md — Unified Service Scheduler

> Source of truth for AI coding agents (Claude Code, Cursor) working in this repository.
> Read this file fully before generating or modifying any code.
> If a request conflicts with this document, **stop and ask** — do not silently deviate.
>
> **This document is a restatement, not the brief itself.** The original requirements are in
> the design-phase transcript (`design-chat.md`, kept outside `docs/`). If the two disagree,
> the brief wins and this file is the bug — an earlier revision silently dropped one of the
> three required deliverables, and nothing downstream could detect it.

---

## 1. Project Context

**What:** A backend service that lets a customer book a vehicle service appointment at a
dealership. A booking is only confirmed when **both** a service bay **and** a technician
qualified for the requested service type are free for the **entire** service duration.

**Why it exists:** Keyloop technical assessment — Scenario A (Unified Service Scheduler),
backend layer. The frontend is deliberately out of scope and is stubbed via an OpenAPI
contract plus cURL examples.

**The brief mandates the use of GenAI** and assesses the candidate's ability to *direct,
validate, and own* AI-generated code. That is not a side note — it is one of the four scored
axes, and it is why `docs/system-design.md` §11 and the README's AI Collaboration Narrative
are deliverables rather than decoration.

### The three required deliverables

| Part | Deliverable | Where it lives |
| --- | --- | --- |
| 1 | **System Design Document** — architecture diagram, component roles, data flow, tech choices with justification, observability strategy, GenAI usage in the design phase | `docs/system-design.md` |
| 2 | **Implementation** — one layer only (backend chosen), the other mocked. Backend requires a RESTful API, a persistent database, and tests | `src/`, `migrations/`, `tests/`, `docs/openapi.yaml` |
| 3 | **Video, 5–10 minutes** — intro, code walkthrough, AI collaboration story, live demo, lessons learned | **Not a repo artifact.** Script/plan tracked separately; the repo must stay demo-able for it |

Part 3 is easy to forget because it produces no file in this repository. It is scored under
the same "Communication & Presentation" axis as the written documents, so a strong repo with
no video loses a quarter of the assessment.

**What is being evaluated** — the four scored axes, verbatim from the brief:

1. **Problem Solving & System Design** — logic, clarity, foresight
2. **Technical Execution** — code quality, correctness, testing
3. **AI Engineering & Verification** — strategy for using AI, and the verify/debug process
4. **Communication & Presentation** — documentation **and video**

**Implication for you (the agent):** correctness of the booking constraint logic and the
quality of its tests matter more than feature breadth. Do not add features that are not
required. Prefer a small, deeply-correct system over a large, shallow one.

**Implication for the demo:** axis 4 is partly earned live. Keep the seeded data and the
cURL examples in the README accurate and runnable at all times, because they are what the
video demonstrates — in particular the parallel-booking race, which is the single most
convincing thing to show on screen.

---

## 2. Non-Negotiable Constraints

These are decided. Do not propose alternatives unless explicitly asked.

| Area | Decision |
| --- | --- |
| Runtime | Node.js 22 LTS, ESM modules |
| Language | TypeScript, `strict: true`, no `any` without an inline justification comment |
| HTTP framework | Fastify (schema-based validation + first-class pino logging) |
| Database | PostgreSQL 16 |
| DB access | Kysely (type-safe query builder, raw SQL where locking semantics matter) |
| Migrations | Kysely migrations, forward-only, checked into `migrations/` |
| Tests | Vitest + Testcontainers (real Postgres, no in-memory fakes for repository tests) |
| Validation | Zod at the HTTP boundary; domain layer assumes validated input |
| Logging | pino, structured JSON, correlation ID on every request |
| Local dev | Docker Compose (Postgres only; app runs on host for fast iteration) |
| API contract | OpenAPI 3.1, generated from Fastify schemas, committed to `docs/openapi.yaml` |

**Forbidden without explicit approval:** ORMs with lazy loading (Prisma/TypeORM), any
in-memory scheduling cache, message queues, Redis, microservice splits, authentication
frameworks, GraphQL, `moment`, `class-validator`.

---

## 3. Architecture

Feature-based Clean Architecture. Dependencies point **inward only**.

```
src/
  domain/                 # Pure business logic. No I/O, no imports from outside domain/.
    scheduling/
      entities.ts         # Appointment, TimeSlot, ServiceType, Technician, ServiceBay
      time-range.ts       # Overlap arithmetic — the heart of the system
      availability.ts     # Pure resource-matching rules
      errors.ts           # Domain errors (NoBayAvailable, NoQualifiedTechnician, ...)
  application/            # Use cases. Orchestrates domain + ports. No SQL, no HTTP.
    scheduling/
      book-appointment.ts
      check-availability.ts
      ports.ts            # Repository interfaces the infrastructure layer implements
  infrastructure/         # Adapters. The only place that knows about Postgres/HTTP.
    db/
      client.ts
      scheduling.repository.ts
    http/
      routes/
      error-mapper.ts     # Domain error -> HTTP status. Single place.
    observability/
      logger.ts
      metrics.ts
  config/                 # Env parsing (Zod), fail fast on startup
  server.ts
migrations/
tests/
  unit/                   # domain/ + application/ with fakes
  integration/            # HTTP + real Postgres via Testcontainers
  concurrency/            # Parallel booking race tests
docs/
  system-design.md
  assumptions.md
  openapi.yaml
```

**Rules:**

- `domain/` imports nothing from `application/` or `infrastructure/`. Ever.
- `application/` depends on interfaces in `ports.ts`, never on concrete repositories.
- Business rules live in `domain/`. If you find yourself writing an `if` about business
  policy inside a route handler or a repository, it belongs in `domain/`.
- One error mapping location: `infrastructure/http/error-mapper.ts`. Handlers throw
  domain errors; they do not construct HTTP responses for failures.

---

## 4. Domain Model

```
Dealership 1---* ServiceBay
Dealership 1---* Technician
Technician *---* ServiceType        (via technician_skills — defines "qualified")
ServiceType     has duration_minutes (fixed per service type)
Customer   1---* Vehicle
Appointment ->  customer, vehicle, dealership, service_type, technician, service_bay,
                start_time, end_time, status
```

**Key invariants** — these must hold at all times, enforced at the database level, not
only in application code:

1. A `service_bay` has **no two appointments whose time ranges overlap**.
2. A `technician` has **no two appointments whose time ranges overlap**.
3. An appointment's `technician` **must** have the appointment's `service_type` in
   `technician_skills`.
4. `end_time = start_time + service_type.duration_minutes`. Never client-supplied.
5. `technician`, `service_bay`, and `appointment` must belong to the same `dealership`.

Invariants 1 and 2 are enforced with Postgres `EXCLUDE USING gist` constraints over
`tstzrange`. Application-level checks are an optimisation and a source of good error
messages — **they are not the safety net**. The database is.

---

## 5. Core Business Rules

### 5.1 Time range semantics

Ranges are **half-open**: `[start, end)`. An appointment ending at 10:00 and one starting
at 10:00 **do not** conflict. This is deliberate and must be reflected in tests.

Overlap predicate: `a.start < b.end AND b.start < a.end`.

### 5.2 Booking algorithm

```
1. Validate request (Zod) -> resolve service_type, dealership, vehicle, customer
2. end_time := start_time + service_type.duration_minutes
3. Reject if the range falls outside dealership business hours (see assumptions.md)
4. BEGIN TRANSACTION (READ COMMITTED)
5. Find candidate bays at the dealership with no overlapping appointment
6. Find candidate technicians at the dealership who
     (a) have the service_type skill, and
     (b) have no overlapping appointment
7. If either set is empty -> throw the specific domain error, rollback
8. Select one bay and one technician (selection policy: see assumptions.md)
9. INSERT appointment
     - the EXCLUDE constraints are the authority here
     - on constraint violation (SQLSTATE 23P01) -> translate to a 409 Conflict,
       do NOT retry silently
10. COMMIT
```

**Do not** implement step 5–6 as a read, then step 9 as an unguarded write and call it
done. That is the exact race this assessment is testing. The `EXCLUDE` constraint plus
correct error translation is what makes it safe under parallel load.

### 5.3 Error semantics

| Situation | Domain error | HTTP |
| --- | --- | --- |
| Payload fails schema | (Zod, at boundary) | 400 |
| Referenced entity not found | `EntityNotFound` | 404 |
| Outside business hours | `OutsideBusinessHours` | 422 |
| No free bay for the range | `NoBayAvailable` | 409 |
| No qualified free technician | `NoQualifiedTechnician` | 409 |
| Lost the race at insert time | `SlotAlreadyTaken` | 409 |

409 responses must state **which** resource was the binding constraint. "Conflict" alone
is not an acceptable response body.

---

## 6. Testing Requirements

Tests are a primary deliverable, not an afterthought. Write the test **before or
alongside** the implementation for anything in `domain/` or `application/`.

**Mandatory coverage:**

- `time-range.ts` — exhaustive boundary cases: identical ranges, touching ranges
  (must NOT conflict), containment both directions, partial overlap both directions,
  zero-length range rejection.
- Qualified-technician matching — a free technician without the skill must be rejected;
  a skilled technician who is busy must be rejected.
- Duration handling — a long service that would run past closing time is rejected.
- **Concurrency test** (`tests/concurrency/`): fire N parallel booking requests for the
  same dealership, service type, and start time where only one bay/technician pair exists.
  Assert exactly **one** 201 and N−1 409s, and assert the appointments table holds exactly
  one row. This test must be deterministic — use `Promise.all`, not timers.

**Rules:**

- No mocking of Postgres in integration tests. Use Testcontainers.
- No test that asserts only "does not throw".
- Every bug found during development gets a regression test before the fix.

---

## 7. Observability

- Every request gets a correlation ID (`x-correlation-id` header, generated if absent),
  attached to the pino child logger and echoed in the response.
- Log at boundaries: request in, request out, DB error, domain rejection. Not in loops.
- Never log PII (customer name, email, phone) or full vehicle VINs — hash or truncate.
- Prometheus `/metrics` exposing at minimum:
  `bookings_total{outcome="confirmed|rejected"}`, `booking_duration_seconds`,
  `availability_query_duration_seconds`.
- `/health` (liveness) and `/health/ready` (checks DB connectivity) as separate endpoints.
- Tracing: OpenTelemetry SDK wired with a console exporter only. Full backend integration
  is described in the design doc, not implemented. Do not expand this scope.

---

## 8. Coding Conventions

- Named exports only. No default exports.
- Explicit return types on every exported function.
- No barrel `index.ts` re-export files.
- Errors are classes extending a `DomainError` base with a stable `code` string.
- Dates: `Date` objects in the domain, `timestamptz` in the DB, ISO 8601 in the API.
  Store UTC; the dealership timezone lives on the dealership record.
- No comments explaining *what* the code does. Comments explain *why* a non-obvious
  decision was made — especially around locking and time arithmetic.
- Conventional Commits. Small commits with real messages; the git history is part of the
  submission and should read as a coherent narrative.

---

## 9. How to Work in This Repo

**Before writing code:**

1. Restate the task and the acceptance criteria in your own words.
2. List the files you intend to create or modify and why.
3. Wait for confirmation on anything touching `domain/scheduling/` or `migrations/`.

**While writing code:**

- Implement the smallest slice that can be tested, then test it, then continue.
- Run `pnpm test` after every meaningful change. Do not batch up untested work.
- If a test fails, fix the cause. Never weaken an assertion to make it pass.

**Stop and ask before:**

- Adding any dependency
- Changing the locking or transaction strategy
- Changing the database schema after it has been seeded
- Introducing caching of any kind
- Deviating from anything in section 2

**Never:**

- Mark work complete without running the test suite
- Claim a test passes without having executed it
- Write "TODO" and move on — surface the gap instead
- Invent business rules. If a rule is unclear, add it to `docs/assumptions.md` and flag it.

---

## 10. Assumptions Register

Ambiguity is expected and is explicitly part of the assessment. Every assumption goes in
`docs/assumptions.md` in this format:

```
### A-007: Technician selection policy
**Assumption:** When multiple qualified technicians are free, select the one with the
fewest appointments that day (load balancing).
**Rationale:** Distributes workload; deterministic given a stable tiebreaker (lowest id).
**If wrong:** Selection becomes a pluggable strategy; the interface already allows this.
**Confidence:** Medium — a real dealership may prioritise specialisation or seniority.
```

Do not resolve ambiguity silently. An undocumented assumption is a defect.

---

## 11. Definition of Done

### Per task

- [ ] Tests written and passing (`pnpm test`)
- [ ] `pnpm typecheck` and `pnpm lint` clean
- [ ] New assumptions recorded in `docs/assumptions.md`
- [ ] OpenAPI spec regenerated (`pnpm openapi`) if the API surface changed —
      the spec is generated from the route schemas and is never hand-edited
- [ ] README cURL examples still accurate, and **re-run** rather than assumed
- [ ] No new dependency added without approval

### Per submission

A green build proves the code behaves as its tests expect. It does not prove the submission
is complete, and it does not prove the implementation honoured this document — that check is
a reading task, and it is the one most easily skipped.

- [ ] **Part 1** — `docs/system-design.md` covers architecture, data flow, tech justification,
      observability, and GenAI usage in the design phase
- [ ] **Part 2** — implementation runs from a clean clone: `pnpm install && pnpm db:reset &&
      pnpm test`
- [ ] **Part 3** — video recorded, 5–10 minutes, covering all five required beats
- [ ] Every claim written in the first person in `docs/` is actually true of the author's
      process. §11 of the design document asserts which decisions were made *without* AI;
      that assertion must be defensible under questioning, or removed
- [ ] Spot-check this document against the original brief. A constraint document that has
      drifted from the brief is worse than none, because everything downstream inherits the
      drift silently — this list exists because exactly that happened once already
