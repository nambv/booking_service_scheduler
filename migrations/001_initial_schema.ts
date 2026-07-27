import { type Kysely, sql } from 'kysely';

/**
 * Forward-only migration. There is deliberately no `down`: rolling a schema
 * backwards on a populated database is a data-loss operation dressed up as a
 * convenience, and this project's recovery story is restore-from-backup.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // gist indexes only understand geometric-style operators out of the box.
  // btree_gist teaches them plain equality, which is what lets a single
  // exclusion constraint combine `service_bay_id WITH =` and `time_range WITH &&`.
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);

  await sql`
    CREATE TABLE dealership (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      timezone    text NOT NULL,
      opens_at    time NOT NULL,
      closes_at   time NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT dealership_hours_ordered CHECK (closes_at > opens_at)
    )
  `.execute(db);

  await sql`
    CREATE TABLE service_type (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name              text NOT NULL UNIQUE,
      duration_minutes  integer NOT NULL,
      CONSTRAINT service_type_duration_positive CHECK (duration_minutes > 0),
      -- Referenced by appointment to make invariant 4 a database guarantee.
      CONSTRAINT service_type_id_duration_unique UNIQUE (id, duration_minutes)
    )
  `.execute(db);

  await sql`
    CREATE TABLE service_bay (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dealership_id  uuid NOT NULL REFERENCES dealership (id) ON DELETE CASCADE,
      name           text NOT NULL,
      UNIQUE (dealership_id, name),
      -- Referenced by appointment to make invariant 5 a database guarantee.
      CONSTRAINT service_bay_id_dealership_unique UNIQUE (id, dealership_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE technician (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dealership_id  uuid NOT NULL REFERENCES dealership (id) ON DELETE CASCADE,
      name           text NOT NULL,
      CONSTRAINT technician_id_dealership_unique UNIQUE (id, dealership_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE technician_skill (
      technician_id    uuid NOT NULL REFERENCES technician (id) ON DELETE CASCADE,
      service_type_id  uuid NOT NULL REFERENCES service_type (id) ON DELETE CASCADE,
      PRIMARY KEY (technician_id, service_type_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE customer (
      id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name   text NOT NULL,
      email  text NOT NULL UNIQUE,
      phone  text NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE vehicle (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id  uuid NOT NULL REFERENCES customer (id) ON DELETE CASCADE,
      vin          text NOT NULL UNIQUE,
      make         text NOT NULL,
      model        text NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE appointment (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id      uuid NOT NULL REFERENCES customer (id),
      vehicle_id       uuid NOT NULL REFERENCES vehicle (id),
      dealership_id    uuid NOT NULL REFERENCES dealership (id),
      service_type_id  uuid NOT NULL,
      technician_id    uuid NOT NULL,
      service_bay_id   uuid NOT NULL,
      time_range       tstzrange NOT NULL,
      status           text NOT NULL DEFAULT 'confirmed',
      created_at       timestamptz NOT NULL DEFAULT now(),

      duration_minutes integer NOT NULL GENERATED ALWAYS AS (
        (EXTRACT(EPOCH FROM (upper(time_range) - lower(time_range))) / 60)::integer
      ) STORED,

      CONSTRAINT appointment_status_valid
        CHECK (status IN ('confirmed', 'cancelled')),

      -- Half-open [start, end) is the system's central time semantic. Storing a
      -- range with any other bound style would silently break the overlap rule.
      CONSTRAINT appointment_range_half_open
        CHECK (NOT isempty(time_range) AND lower_inc(time_range) AND NOT upper_inc(time_range)),

      CONSTRAINT appointment_range_bounded
        CHECK (lower(time_range) IS NOT NULL AND upper(time_range) IS NOT NULL),

      -- Invariant 4: the booked duration must equal the service type's duration,
      -- so a client cannot squeeze a long job into a short gap.
      CONSTRAINT appointment_duration_matches_service_type
        FOREIGN KEY (service_type_id, duration_minutes)
        REFERENCES service_type (id, duration_minutes),

      -- Invariant 5: technician and bay must belong to the appointment's dealership.
      CONSTRAINT appointment_technician_same_dealership
        FOREIGN KEY (technician_id, dealership_id)
        REFERENCES technician (id, dealership_id),

      CONSTRAINT appointment_bay_same_dealership
        FOREIGN KEY (service_bay_id, dealership_id)
        REFERENCES service_bay (id, dealership_id),

      -- Invariant 3: the assigned technician must hold the requested skill.
      CONSTRAINT appointment_technician_qualified
        FOREIGN KEY (technician_id, service_type_id)
        REFERENCES technician_skill (technician_id, service_type_id)
    )
  `.execute(db);

  // Invariants 1 and 2, and the reason this project chose PostgreSQL.
  //
  // These are the authority on double-booking, not the availability query that
  // runs before the insert. That query exists to produce a useful rejection
  // message; this constraint is what makes the rejection true under concurrency.
  //
  // The `status = 'confirmed'` predicate is here from the first migration even
  // though cancellation is out of scope, so that a cancelled appointment stops
  // blocking its slot without a constraint rebuild on a populated table.
  await sql`
    ALTER TABLE appointment
      ADD CONSTRAINT no_bay_overlap
      EXCLUDE USING gist (service_bay_id WITH =, time_range WITH &&)
      WHERE (status = 'confirmed')
  `.execute(db);

  await sql`
    ALTER TABLE appointment
      ADD CONSTRAINT no_technician_overlap
      EXCLUDE USING gist (technician_id WITH =, time_range WITH &&)
      WHERE (status = 'confirmed')
  `.execute(db);

  // The exclusion constraints create gist indexes on (resource, time_range),
  // which already serve the availability queries. These two cover the remaining
  // access paths: listing a dealership's day, and resolving a customer's history.
  await sql`
    CREATE INDEX appointment_dealership_time_idx
      ON appointment USING gist (dealership_id, time_range)
      WHERE status = 'confirmed'
  `.execute(db);

  await sql`CREATE INDEX appointment_customer_idx ON appointment (customer_id)`.execute(db);

  await sql`
    CREATE INDEX technician_skill_service_type_idx
      ON technician_skill (service_type_id, technician_id)
  `.execute(db);
}
