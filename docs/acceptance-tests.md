# Acceptance Tests — cURL runbook

A manual, runnable acceptance-test script for the Unified Service Scheduler. Each section is
one acceptance criterion (AC): a copy-paste cURL command and the result it must produce. Every
command was executed against a running server on seed data — the outputs are copied from the
actual run, not written by hand.

**Every command below is self-contained** — the seed ids are inlined, so you can paste any
block straight into a terminal without setting anything up first.

**All error responses share one envelope** — `{"error":{"code","message","details?","bindingResource?"}}`.
Every error example below pipes to `jq -c '.error'` to show that inner object in the same
shape; only the success case (AC-1) returns the resource at the top level.

> This complements the automated suite (`pnpm test`, 112 tests). The automated tests are the
> source of truth; this file is for demonstrating the behaviour by hand — in the video, in an
> interview, or when smoke-checking a fresh deploy.

## Prerequisites

```bash
pnpm db:up && pnpm db:migrate && pnpm db:seed   # Postgres on :55432, seeded
pnpm start                                       # server on http://localhost:3000
```

### The seed ids used below (for reference — no need to export anything)

| Meaning | Id |
| --- | --- |
| Dealership — London (08:00–18:00 Europe/London) | `10000000-0000-0000-0000-000000000001` |
| Dealership — Manchester (09:00–17:00 Europe/London) | `10000000-0000-0000-0000-000000000002` |
| Dealership — Ho Chi Minh (08:00–17:00 Asia/Ho_Chi_Minh) | `10000000-0000-0000-0000-000000000003` |
| Service — Oil Change (30 min) | `20000000-0000-0000-0000-000000000001` |
| Service — Gearbox Rebuild (240 min) | `20000000-0000-0000-0000-000000000006` |
| Customer — Harper Ellis | `50000000-0000-0000-0000-000000000001` |
| Vehicle — Volkswagen Golf | `60000000-0000-0000-0000-000000000001` |

Reset to a clean slate at any time:

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"
```

> **Time note.** `startTime` must be **in the future** and **within the dealership's local
> business hours**. `09:00Z` is `10:00` in London (BST). The examples use `2026-08-03`
> (a Monday) — adjust to a future weekday if you run this later.

---

## AC-1 — Book an appointment → **201**, end time derived server-side

The client sends a start time only; the server derives `endTime` from the service duration
and picks the technician and bay itself.

```bash
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "50000000-0000-0000-0000-000000000001",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "startTime":     "2026-08-03T09:00:00Z"
}' | jq
```

**Expected — 201:**
```json
{
  "id": "…",
  "dealershipId": "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "technicianId": "…",          // chosen by the server
  "serviceBayId": "…",          // chosen by the server
  "startTime": "2026-08-03T09:00:00.000Z",
  "endTime": "2026-08-03T09:30:00.000Z",   // 30 min later — never sent by the client
  "status": "confirmed"
}
```

---

## AC-2 — Malformed payload → **400 VALIDATION_FAILED**

```bash
# missing required fields
curl -s -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001"}' | jq -c '.error'

# id that is not a UUID
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "not-a-uuid",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "startTime":     "2026-08-03T09:00:00Z"
}' | jq -c '.error'
```

**Expected — 400**, same envelope. `details.issues` carries one `{field, message}` per invalid
field — a minimal shape with a human-readable message, no internal schema paths or regex:
```json
{"code":"VALIDATION_FAILED","message":"Request failed schema validation","details":{"issues":[{"field":"customerId","message":"Must be a valid UUID"}]}}
```
The missing-fields request returns the same shape with one issue per absent field:
```json
{"code":"VALIDATION_FAILED","message":"Request failed schema validation","details":{"issues":[{"field":"vehicleId","message":"Required"},{"field":"dealershipId","message":"Required"},{"field":"serviceTypeId","message":"Required"},{"field":"startTime","message":"Required"}]}}
```

---

## AC-3 — Referenced entity absent → **404 ENTITY_NOT_FOUND**

```bash
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "50000000-0000-0000-0000-000000000001",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "00000000-0000-0000-0000-0000000000ff",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "startTime":     "2026-08-03T09:00:00Z"
}' | jq -c '.error'
```

**Expected — 404:**
```json
{"code":"ENTITY_NOT_FOUND","message":"Dealership '00000000-0000-0000-0000-0000000000ff' does not exist","details":{"entity":"Dealership","id":"00000000-0000-0000-0000-0000000000ff"}}
```

---

## AC-4 — Outside business hours → **422 OUTSIDE_BUSINESS_HOURS**

```bash
# before opening: 04:00Z = 05:00 London, opens 08:00
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "50000000-0000-0000-0000-000000000001",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "startTime":     "2026-08-03T04:00:00Z"
}' | jq -c '.error'

# past closing: Gearbox is 240 min; 15:30Z = 16:30 London runs to 20:30, past 18:00
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "50000000-0000-0000-0000-000000000001",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000006",
  "startTime":     "2026-08-03T15:30:00Z"
}' | jq -c '.error'
```

**Expected — 422**, one for each reason:
```json
{"code":"OUTSIDE_BUSINESS_HOURS","message":"Requested range falls outside business hours (before_opening)","details":{"reason":"before_opening"}}
{"code":"OUTSIDE_BUSINESS_HOURS","message":"Requested range falls outside business hours (after_closing)","details":{"reason":"after_closing"}}
```

---

## AC-5 — Booking in the past → **422 BOOKING_IN_THE_PAST**

```bash
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "50000000-0000-0000-0000-000000000001",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "10000000-0000-0000-0000-000000000001",
  "serviceTypeId": "20000000-0000-0000-0000-000000000001",
  "startTime":     "2020-01-01T09:00:00Z"
}' | jq -c '.error'
```

**Expected — 422:**
```json
{"code":"BOOKING_IN_THE_PAST","message":"Appointments cannot be booked in the past","details":{"requestedStart":"2020-01-01T09:00:00.000Z"}}
```

---

## AC-6 — No qualified technician → **409**, names the resource

Manchester (`…002`) employs nobody who can rebuild a gearbox — a deliberate gap in the seed
skill matrix, so this is reachable without first filling the calendar.

```bash
curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' -d '{
  "customerId":    "50000000-0000-0000-0000-000000000001",
  "vehicleId":     "60000000-0000-0000-0000-000000000001",
  "dealershipId":  "10000000-0000-0000-0000-000000000002",
  "serviceTypeId": "20000000-0000-0000-0000-000000000006",
  "startTime":     "2026-08-03T09:00:00Z"
}' | jq -c '.error'
```

**Expected — 409:**
```json
{"code":"NO_QUALIFIED_TECHNICIAN","message":"No technician qualified for this service type is free for the entire requested range","bindingResource":"technician"}
```

Every 409 names its binding resource — "Conflict" alone is not an acceptable body.

---

## AC-7 — Capacity is enforced, and enforced under concurrency

London has exactly **one** technician who can rebuild a gearbox, so this slot's capacity is 1.

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"

# sequential: first succeeds, second is refused
curl -s -o /dev/null -w 'first  -> %{http_code}\n' -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}'

curl -s -o /dev/null -w 'second -> %{http_code}\n' -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}'
```
**Expected:** `first -> 201`, `second -> 409`.

The important one — fire ten in parallel into that single-capacity slot:

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"

for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/appointments \
    -H 'content-type: application/json' \
    -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}' &
done | sort | uniq -c

docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -tAc \
  "SELECT 'rows in appointments: '||count(*) FROM appointments WHERE status='confirmed'"
```

**Expected — exactly one winner, and exactly one row:**
```
   1 201
   9 409
rows in appointments: 1
```

This is the whole point of the project: the non-overlap invariant is enforced by a Postgres
`EXCLUDE` constraint, so the race is safe no matter how the requests interleave.

---

## AC-8 — Touching appointments do not conflict (half-open `[start, end)`)

Two gearbox jobs back-to-back on the **same** single technician: `08:00–12:00` then
`12:00–16:00`. They share the instant `12:00`, which belongs to the second only.

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"

curl -s -o /dev/null -w '08:00Z -> %{http_code}\n' -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}'

curl -s -o /dev/null -w '12:00Z -> %{http_code}\n' -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T12:00:00Z"}'
```

**Expected:** both `201`. A closed-interval implementation would reject the second.

---

## AC-9 — Cancel frees the slot, with no compensating write → **200**

`ID=$(…)` captures the server-generated appointment id so the next line can cancel it — that
is a runtime result, not a setup variable.

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"

# book the only gearbox slot -> 201, capture its id
ID=$(curl -s -X POST localhost:3000/appointments -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}' | jq -r .id)

# the slot is now full
curl -s -o /dev/null -w 'book again (full) -> %{http_code}\n' -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}'

# cancel -> 200 cancelled
curl -s -X DELETE "localhost:3000/appointments/$ID" | jq -c '{status}'

# book the same time again -> 201, the slot was freed
curl -s -o /dev/null -w 'book again (freed) -> %{http_code}\n' -X POST localhost:3000/appointments \
  -H 'content-type: application/json' \
  -d '{"customerId":"50000000-0000-0000-0000-000000000001","vehicleId":"60000000-0000-0000-0000-000000000001","dealershipId":"10000000-0000-0000-0000-000000000001","serviceTypeId":"20000000-0000-0000-0000-000000000006","startTime":"2026-08-10T08:00:00Z"}'
```

**Expected:**
```
book again (full)  -> 409
{"status":"cancelled"}
book again (freed) -> 201
```

No code releases the bay or technician — both exclusion constraints are scoped to
`status='confirmed'`, so flipping the status removes the row from their scope. The cancelled
row is kept (auditable), not deleted.

---

## AC-10 — Cancel is idempotent, and 404 for an unknown id

```bash
# reuses $ID captured in AC-9
curl -s -o /dev/null -w 'cancel once  -> %{http_code}\n' -X DELETE "localhost:3000/appointments/$ID"
curl -s -o /dev/null -w 'cancel twice -> %{http_code}\n' -X DELETE "localhost:3000/appointments/$ID"
curl -s -o /dev/null -w 'unknown id   -> %{http_code}\n' -X DELETE "localhost:3000/appointments/00000000-0000-0000-0000-0000000000ff"
```

**Expected:** `200`, `200` (idempotent — HTTP requires it), `404`.

---

## AC-11 — Cannot cancel once the service has started → **422**

The API refuses to book in the past, so a started appointment is seeded directly to
demonstrate the rule. Ids used: London (`…001`), Gearbox (`…006`), Alex the London gearbox
technician (`40000000-…-0001-…001`), London Bay 1 (`30000000-…-0001-…001`).

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"

ID=$(docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -tAc \
  "INSERT INTO appointments (customer_id,vehicle_id,dealership_id,service_type_id,technician_id,service_bay_id,time_range)
   VALUES ('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',
           '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000006',
           '40000000-0000-0000-0001-000000000001','30000000-0000-0000-0001-000000000001',
           tstzrange('2020-01-01T08:00:00Z','2020-01-01T12:00:00Z','[)'))
   RETURNING id" | grep -oE '[0-9a-f-]{36}')

curl -s -X DELETE "localhost:3000/appointments/$ID" | jq -c '.error'
```

**Expected — 422:**
```json
{"code":"APPOINTMENT_ALREADY_STARTED","message":"An appointment cannot be cancelled once its service has started","details":{"startedAt":"2020-01-01T08:00:00.000Z"}}
```
Once the car is on the ramp, "cancelled" is the wrong word for what happened.

---

## AC-12 — Availability is advisory and takes no slot → **200**

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"

# London / Oil Change — has capacity
curl -s "localhost:3000/availability?dealershipId=10000000-0000-0000-0000-000000000001&serviceTypeId=20000000-0000-0000-0000-000000000001&startTime=2026-08-03T11:00:00Z" \
  | jq -c '{available,freeBays,freeQualifiedTechnicians,reason}'

# Manchester / Gearbox — nobody qualified
curl -s "localhost:3000/availability?dealershipId=10000000-0000-0000-0000-000000000002&serviceTypeId=20000000-0000-0000-0000-000000000006&startTime=2026-08-03T09:00:00Z" \
  | jq -c '{available,reason}'
```

**Expected:**
```json
{"available":true,"freeBays":5,"freeQualifiedTechnicians":4,"reason":null}
{"available":false,"reason":"no_qualified_technician"}
```

It reports what a booking *would* do without creating anything — and a `true` here can still
be followed by a `409` if another caller books in between.

---

## AC-13 — Business hours are per-dealership local time (timezone + DST)

The **same** UTC instant is inside one dealership's window and outside another's.
`03:00Z` = `10:00` in Ho Chi Minh (`…003`, open) but `04:00` in London (`…001`, before opening).

```bash
curl -s "localhost:3000/availability?dealershipId=10000000-0000-0000-0000-000000000003&serviceTypeId=20000000-0000-0000-0000-000000000001&startTime=2026-08-03T03:00:00Z" | jq -c '{available,reason}'
curl -s "localhost:3000/availability?dealershipId=10000000-0000-0000-0000-000000000001&serviceTypeId=20000000-0000-0000-0000-000000000001&startTime=2026-08-03T03:00:00Z" | jq -c '{available,reason}'
```

**Expected:**
```json
{"available":true,"reason":null}
{"available":false,"reason":"before_opening"}
```

---

## AC-14 — Correlation id echoed on every response

```bash
# supplied id is echoed back
curl -s -o /dev/null -D - localhost:3000/health -H 'x-correlation-id: my-trace-42' | grep -i x-correlation-id

# absent id is generated
curl -s -o /dev/null -D - localhost:3000/health | grep -i x-correlation-id
```

**Expected:** `x-correlation-id: my-trace-42`, then a generated UUID. One id retrieves the
whole story of a request from the logs.

---

## AC-15 — Operational endpoints

```bash
curl -s -w ' [%{http_code}]\n' localhost:3000/health        # {"status":"ok"} [200]
curl -s -w ' [%{http_code}]\n' localhost:3000/health/ready   # {"status":"ready"} [200]  (checks the DB)
curl -s localhost:3000/metrics | grep -E '^(bookings_total|booking_rejections_total|cancellations_total)'
```

**Expected:** `/health` and `/health/ready` return `200`; `/metrics` exposes Prometheus
counters such as `bookings_total{outcome="confirmed",dealership_id="…"}`.

---

## Cleanup

```bash
docker exec keylooop_service_scheduler-postgres-1 psql -U scheduler -d scheduler -c "DELETE FROM appointments"
```

Or browse and drive everything from **Swagger UI at http://localhost:3000/swagger** — same
origin as the API, so "Try it out" calls it for real.
