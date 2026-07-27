# Assumptions Register

Scenario A — Unified Service Scheduler.

The brief states that requirements are deliberately ambiguous and that reasonable
assumptions should be made and documented. This file is that record. Each entry states
what was assumed, why it is reasonable, what changes if it turns out to be wrong, and how
confident I am in it.

**How to read the confidence column:** *High* means I would defend this in a design
review with a real dealership stakeholder. *Medium* means it is defensible but a real
customer might well decide otherwise. *Low* means I picked something workable to keep
moving and would raise it as an open question in the first sprint.

**Design principle applied throughout:** where an assumption is low-confidence, the code
isolates it behind a boundary so that changing it is a local edit, not a redesign. Those
boundaries are called out explicitly below.

---

## Scope and Actors

### A-001: The booking actor is a dealership-side user, not the end customer
**Assumption:** The API is consumed by a service advisor booking on a customer's behalf,
or by an authenticated customer portal. The service itself treats `customer_id` as a
trusted input and performs no authentication or authorisation.
**Rationale:** The brief scopes the deliverable to the scheduling capability. Auth is a
cross-cutting concern that would normally sit in an API gateway or identity service, not
in this bounded context. Building it here would consume assessment time without
demonstrating anything about the actual problem.
**If wrong:** Add an auth middleware in `infrastructure/http/`. The domain and application
layers are unaffected because they never read identity from the transport.
**Confidence:** High.

### A-002: Out of scope — rescheduling, no-shows, and pricing. Cancellation was added.
**Assumption (original):** The service implements booking and availability query only.
Appointments carry a `status` column so the lifecycle can be extended later, and the
`EXCLUDE` constraints carry `WHERE status = 'confirmed'` from the first migration — costing
nothing now, so that cancelled rows stop blocking slots the day cancellation ships, rather
than requiring a constraint rebuild on a populated table.
**Rationale:** The three core requirements in the brief cover request, availability check,
and record creation. Cancellation is an obvious next feature, not a stated one.
**What actually happened:** cancellation was implemented after the fact
(`DELETE /appointments/:id`), and the prediction held exactly. Freeing the slot required
**no compensating write and no migration** — flipping `status` to `cancelled` removes the row
from the constraints' scope, and the time becomes bookable in the same transaction. The
integration test asserts precisely this: book the only gearbox slot, confirm a second booking
gets 409, cancel, then book the same time successfully.

This is the clearest evidence in the repository that a cheap decision taken early against a
*predicted* requirement paid for itself. Rescheduling, no-shows and pricing remain out of
scope; rescheduling in particular is cancel-plus-book and would need a decision about whether
the two halves must be atomic.
**Confidence:** High — no longer a prediction.

---

## Time and Duration

### A-003: Service duration is fixed per service type
**Assumption:** Each `service_type` has a `duration_minutes` value. Every appointment for
that type occupies exactly that duration. Duration is never supplied by the client.
**Rationale:** The brief says availability must be checked "for the entire service
duration", implying the duration is a known property of the service rather than a
negotiated input. Deriving it server-side also removes a trivial abuse vector where a
client books a two-hour job into a fifteen-minute gap.
**If wrong:** Real workshops vary duration by vehicle model, technician skill, and
historical actuals. The fix is to replace a column read with a `DurationPolicy` service
that takes `(service_type, vehicle)`. The application layer already calls a single
function to compute `end_time`, so this is one substitution point.
**Confidence:** Medium — this is the assumption most likely to be challenged in a real
implementation.

### A-004: No buffer or changeover time between appointments
**Assumption:** A bay or technician can start a new job at the exact instant the previous
one ends. Time ranges are half-open `[start, end)`, so touching appointments do not
conflict.
**Rationale:** Introducing a buffer requires deciding whether it belongs to the bay
(cleaning), the technician (breaks), or the service type (paint curing) — three different
models with no basis in the brief to choose between them. Zero buffer is the simplest
defensible default and makes the boundary semantics unambiguous.
**If wrong:** A buffer is added by widening the range used in the conflict check rather
than by changing the appointment's own start and end. Keeping the buffer out of the stored
range means reporting and customer-facing times stay honest.
**Confidence:** Medium.

### A-005: All timestamps are stored in UTC; each dealership carries its own timezone
**Assumption:** `timestamptz` in Postgres, UTC in the domain, ISO 8601 with offset at the
API boundary. Business hours are interpreted in the dealership's local timezone.
**Rationale:** Keyloop operates across multiple countries, so a single-timezone assumption
would be wrong on day one. Storing UTC and resolving locality at the edge is the standard
approach and avoids DST arithmetic in the core.
**If wrong:** Low risk. The known sharp edge is that a business-hours window spanning a
DST transition can be 23 or 25 hours long; the check is written against local wall-clock
time to stay correct through that.
**Confidence:** High.

### A-006: Bookings are accepted at any minute, not on a fixed slot grid
**Assumption:** A request for 09:07 is valid. The system does not round to 15- or
30-minute boundaries.
**Rationale:** The brief says the user requests "a desired time", with no mention of
slots. Free-form times are also the harder case to get right, so solving it means the
slot-grid variant is a trivial restriction on top rather than a rework.
**If wrong:** Add a validation rule at the boundary. No domain change.
**Confidence:** Medium — most real booking UIs present a grid, but that is a presentation
concern the backend need not impose.

### A-007: Business hours are uniform per dealership, with no per-day variation or holidays
**Assumption:** Each dealership has a single `opens_at` / `closes_at` pair applying to
every day. An appointment must fit entirely within that window. Weekends and public
holidays are not modelled.
**Rationale:** A full calendar model (per-weekday hours, holiday calendars per country,
seasonal hours) is a meaningful subsystem in its own right and would crowd out the
resource-constraint logic that this assessment is actually about.
**If wrong:** Replace the two-column check with a `BusinessCalendar` port. The application
layer asks a single question — "is this range within opening hours for this dealership?" —
so the implementation behind it can grow arbitrarily without touching callers.
**Confidence:** Low. This is the weakest assumption in the register and the first thing I
would fix given more time.

### A-008: Bookings must be in the future; no maximum advance window
**Assumption:** `start_time` must be after the current time. There is no upper bound on
how far ahead a booking may be made.
**Rationale:** Rejecting past bookings is obviously correct. An advance-booking limit is a
commercial policy with no basis in the brief, and inventing a number would be arbitrary.
**If wrong:** One additional validation rule.
**Confidence:** High.

---

## Resources and Matching

### A-009: "Qualified" means the technician holds the service type as a skill
**Assumption:** Qualification is a boolean many-to-many relationship
(`technician_skills`). There are no proficiency levels, certifications with expiry dates,
or manufacturer-specific authorisations.
**Rationale:** The brief says "a qualified Technician" without further definition. A
boolean skill match is the minimal model that satisfies the requirement and is the base
that any richer model would extend.
**If wrong:** Adding a proficiency level or a validity window changes the join predicate
in one query. The candidate-technician query is deliberately isolated in the repository
for this reason.
**Confidence:** High.

### A-010: Exactly one technician and one bay per appointment
**Assumption:** An appointment holds a single technician and a single bay for its whole
duration. Multi-technician jobs and mid-job handovers are not supported.
**Rationale:** The brief's third requirement describes an appointment record associating
"the customer, vehicle, technician, and service bay" — singular. Modelling resource
assignment as a collection would be speculative generality.
**If wrong:** This is the most structurally expensive assumption to reverse. It would mean
promoting assignment to its own `appointment_resources` table and moving the `EXCLUDE`
constraints onto it. I have noted it here rather than pre-building for it, because the
brief's wording is explicit and building the general case would trade certain complexity
for uncertain benefit.
**Confidence:** High for this brief; flagged as a known extension cost.

### A-011: All service bays are interchangeable
**Assumption:** Any bay at a dealership can host any service type. Bays have no equipment
attributes, size limits, or vehicle-type restrictions.
**Rationale:** The brief describes the bay purely as a capacity constraint. Modelling bay
capability would duplicate the technician-skill mechanism without demonstrating anything
new.
**If wrong:** The bay-candidate query gains the same kind of capability join the
technician query already has. The structure is already there to copy.
**Confidence:** Medium — in reality a heavy-duty lift or an alignment rig is not
interchangeable with a general bay.

### A-012: Technicians and bays belong to exactly one dealership
**Assumption:** No resource is shared between dealership sites, and an appointment's
technician, bay, and dealership must all agree.
**Rationale:** Cross-site resource sharing implies travel time between locations, which is
a materially different scheduling problem.
**If wrong:** Would require a travel-time model in the conflict check, not just a
relationship change.
**Confidence:** High.

### A-013: Technicians are available for the whole of business hours
**Assumption:** No shift patterns, breaks, annual leave, or sickness. A technician is free
whenever they have no overlapping appointment and the dealership is open.
**Rationale:** Technician availability calendars are the same shape of problem as
dealership business hours (A-007) and would be solved the same way. Solving it twice adds
no new insight.
**If wrong:** The technician-candidate query gains an availability-window join. Because
availability is already expressed as "no overlapping range", absences can be modelled as
blocking ranges in the same table — meaning the conflict logic itself does not change at
all. This is a deliberate property of the design.
**Confidence:** Low, but cheap to fix.

---

## Selection and Concurrency

### A-014: When several resources are free, pick the least-loaded, breaking ties at random
**Assumption:** Among free qualified technicians, select the one with the fewest confirmed
appointments on that date. Same policy for bays. Ties break **uniformly at random**.
**Rationale:** The brief does not specify a selection policy. Load balancing is a neutral,
explainable default. The tiebreak was originally lowest-id, for determinism — that turned
out to be a measured mistake, not a safe simplification: because every concurrent request
for the same slot then computes the *same* lowest-id pair, they all collide on the exclusion
constraint and only one survives. Measured on seed data, 12 concurrent bookings into a slot
with capacity for 4 filled 1 of the 4. A random tiebreak scatters the choices and fills 4 of
4 (see A-021 for the bounded re-selection that complements this). The determinism argument
does not actually cost the test suite anything: the mandatory concurrency test (section 6)
uses a slot with exactly one bay/technician pair, where there is no tie to break, so it stays
deterministic regardless. Where a test needs a pinned choice, the random source is injected.
**If wrong:** Real dealerships often prefer specialisation, seniority, or minimising
fragmentation of the day. Selection is isolated behind one function (`selectLeastLoaded`)
precisely because I expect this to be the assumption a customer overrides first.
**Confidence:** Medium.

### A-015: A booking re-selects on a lost race, but never changes what the caller asked for
**Assumption:** When two requests contend and one loses the exclusion-constraint race, the
service re-selects a *different technician or bay* for the same dealership, service and start
time, up to a small bounded number of attempts (A-021). It never silently moves the booking
to a different **time**, and it never offers the next available slot. When re-selection is
exhausted the loser receives 409 naming the resource that was contended.
**Rationale:** The caller asks for a dealership, a service, and a start time — not for a
specific technician or bay. Choosing a different technician therefore changes nothing the
caller asked for, so it is not the "surprising silent retry" that a naive retry loop would
be. Retrying at a different *time* would change the caller's intent, and is refused. This is
a narrowing of the original assumption, which refused all retries; measuring the throughput
cost of that refusal (A-014) is what prompted the change.
**If wrong:** If any re-selection is unacceptable — for example when a caller really does
pin a named technician — the loop is disabled by setting the attempt bound to 1, with no
other change.
**Confidence:** High.

### A-016: Booking requests are not idempotent
**Assumption:** No idempotency key. Two identical requests produce two appointments if
resources allow.
**Rationale:** Idempotency matters most for payment-like operations and for clients with
aggressive retry behaviour. Neither is in evidence here.
**If wrong:** This is a real production gap and I would raise it before launch. An
`Idempotency-Key` header mapping to a stored request hash is the standard fix and does not
touch the domain layer.
**Confidence:** Medium — defensible for an assessment, would not ship without revisiting.

---

## Data

### A-017: Vehicle ownership is not validated against the requesting customer
**Assumption:** The service checks that the vehicle and customer exist, but not that the
vehicle belongs to that customer.
**Rationale:** Follows from A-001. Ownership is an authorisation question, and the service
has no identity context to authorise against.
**If wrong:** Becomes a check in the same middleware that resolves identity.
**Confidence:** High.

### A-018: Seed data represents a single mid-sized dealership group
**Assumption:** Three dealerships, four to six bays and technicians each, six service
types with durations from 30 to 240 minutes, and a skill matrix with deliberate gaps so
that "no qualified technician" is reachable in testing.
**Rationale:** The seed data is a test fixture. It is shaped to make every rejection path
in the system reproducible by hand from the README's cURL examples, which matters more
than realistic volume.
**If wrong:** Performance characteristics at a thousand dealerships are addressed in the
design document's scalability section rather than in the fixture.
**Confidence:** High.

---

### A-021: Bounded re-selection after a lost race
**Assumption:** A booking attempt that loses the exclusion-constraint race re-runs the whole
availability-and-insert step at most **3 times** before giving up with 409. Each attempt is a
separate transaction.
**Rationale:** The separate transaction is not incidental — a failed statement aborts its
transaction in Postgres, so retrying inside one is impossible without savepoints, and a fresh
transaction takes a fresh snapshot that makes the just-committed winner visible, so the next
attempt stops choosing the resource that lost. The bound of 3, combined with the random
tiebreak (A-014), fills a 4-capacity slot completely under 12-way contention in every
measured run; without the random tiebreak the same bound only reaches ~2.6 of 4, which is
why both changes are needed together. A bound is essential regardless: without one, a
permanently contended slot would spin.
**If wrong:** The bound is a single constant. Under contention heavier than the seed data
exercises, it may need tuning, and the honest home for that decision is a load test against
production-shaped data, not a guess here.
**Confidence:** Medium — the mechanism is right; the specific number is calibrated only
against seed-scale contention.

### A-022: A deadlock on insert is retried, not surfaced as a 500
**Assumption:** Concurrent inserts of overlapping ranges can deadlock on the exclusion
constraints' gist indexes (SQLSTATE 40P01), not only lose cleanly (23P01). A deadlock is
treated as a transient, retryable event: the same bounded re-selection loop as A-021 re-runs
it on a fresh transaction. It reaches the client as a 409 (`BOOKING_CONTENDED`) only if every
retry also deadlocks; it is never a 500.
**Rationale:** This was found, not foreseen — the concurrency test surfaced 40P01 escaping as
a 500 under 20-way contention, which is exactly the class of bug that test exists to catch. A
deadlock victim did not necessarily lose the slot, so retrying on a fresh transaction (whose
new snapshot sees any committed winner) is the correct response; the loser's next attempt
either succeeds or gets a clean 23P01. Measured over 320 concurrent requests after the fix, no
deadlock escaped the retries and no booking was ever duplicated. Retrying deadlocks is the
textbook response to 40P01, and the per-attempt fresh transaction the design already needed
(A-021) is precisely the mechanism it requires.
**If wrong:** If a deadlock ever did survive the retries in production, `BOOKING_CONTENDED`
is a 409 the client may safely retry. If it proved common, the remedy is to reduce the
contention window — a shorter transaction, or serialising inserts per (dealership, slot) — not
a larger retry count.
**Confidence:** High — verified under load rather than argued.

### A-023: An appointment cannot be cancelled once its service has started
**Assumption:** Cancelling an appointment whose `start_time` is at or before now is refused
with 422 `APPOINTMENT_ALREADY_STARTED`. The boundary is inclusive: at the exact start instant
it is already too late.
**Rationale:** Once a technician has the car on the ramp, "cancelled" is the wrong word for
what happened — the correct concept is a no-show, an abandonment, or a completed job, and each
carries different billing consequences. Silently allowing a cancellation here would let the
schedule disagree with what physically occurred, and would free a bay that is not actually
free. Refusing is the honest answer until the vocabulary exists.
**If wrong:** If the business does want late cancellation, it becomes a separate transition
(`no_show`, `abandoned`) with its own status value rather than a relaxation of this rule —
the constraint predicate already keys on `status = 'confirmed'`, so a new terminal status
frees the slot the same way.
**Confidence:** Medium — the rule is defensible, but where exactly the cut-off belongs (at
start, or some minutes before) is a product decision I would raise.

### A-024: Cancellation is idempotent
**Assumption:** Cancelling an already-cancelled appointment returns 200 with the appointment
unchanged, rather than an error. Two callers cancelling simultaneously both receive success.
**Rationale:** HTTP requires DELETE to be idempotent, and the caller's intent — "this booking
should not stand" — is satisfied either way. The repository makes the update conditional
(`AND status = 'confirmed'`), so exactly one writer changes the row while both observe the
desired end state; the loser re-reads rather than failing. Note this is a narrower claim than
A-016, which says *booking* is not idempotent: creating a resource twice produces two
appointments, whereas cancelling twice cannot produce two cancellations.
**If wrong:** If a caller must distinguish "I cancelled it" from "it was already cancelled",
the conditional update already returns that fact — it is discarded at the use-case boundary
and could be surfaced as a response field without touching the query.
**Confidence:** High.

---

## Schema Enforcement

### A-019: A service type's duration is immutable once any appointment references it
**Assumption:** Invariant 4 (`end_time = start_time + service_type.duration_minutes`) is
enforced by the database, not only by the application: `appointment` carries a generated
`duration_minutes` column derived from `time_range`, and a composite foreign key to
`service_type (id, duration_minutes)`. The direct consequence, confirmed by testing rather
than assumed, is that `UPDATE service_type SET duration_minutes = ...` fails with `23503`
while any appointment references that (id, duration) pair.
**Rationale:** CLAUDE.md requires every invariant to hold at the database level, not merely
in application code. A generated column plus a composite FK achieves that declaratively —
no trigger, no stored procedure, no application check that a future migration script or a
manual `INSERT` could bypass. The immutability that falls out of it is arguably correct
behaviour rather than a side effect: retroactively changing what a booked job was scheduled
to take would rewrite history that customers were quoted against.
**If wrong:** If a customer needs to retune durations while a live calendar exists, the fix
is to version service types — a new row per duration change, with appointments pointing at
the version they were booked under. The cheaper fallback is to drop this one foreign key and
enforce invariant 4 in the application, accepting that the guarantee weakens from "cannot
happen" to "our code does not do it". Both are one migration; neither touches the domain
layer.
**Confidence:** Medium. The enforcement is right; whether the resulting immutability is
acceptable operationally is a product question I would raise before launch.

### A-020: Migrations are forward-only, with no `down` step
**Assumption:** Migration files export `up` and nothing else. Reversal is restore-from-backup.
**Rationale:** A `down` migration on a populated table is a data-loss operation wearing the
costume of a convenience, and it is almost never exercised, so it is almost never correct.
**If wrong:** For a genuine need to roll back, the honest form is a new forward migration
that undoes the change explicitly.
**Confidence:** High.

---

## Open Questions I Would Raise With a Product Partner

These are not assumptions — they are things I could not reasonably decide alone, listed
here because surfacing them is part of the job.

1. **Does a customer see availability before requesting, or request blind?** This changes
   whether `GET /availability` is a core endpoint or a convenience, and materially affects
   how often the 409 path is hit in production.
2. **What is the real cost of a wrong assignment?** If reassigning a technician after
   booking is cheap, an optimistic policy with later optimisation beats strict
   point-in-time matching. If it is expensive, the constraint model should be stricter
   than what is built here.
3. **Who owns the duration estimate, and is it allowed to be wrong?** A-003 assumes a
   fixed duration. If actual job times routinely overrun, the schedule degrades through the
   day and no amount of booking-time correctness fixes it. That is a product problem before
   it is an engineering one.
