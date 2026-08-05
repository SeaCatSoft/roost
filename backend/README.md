# Roost backend

PostgreSQL on Supabase. There is no server to write or host — Supabase exposes an
API over these tables directly, and row-level security decides what each signed-in
person can reach.

```
migrations/001_schema.sql     tables, types, constraints
migrations/002_views.sql      everything the planner computes with a formula
migrations/003_security.sql   row-level security + invitations
migrations/004_seed.sql       your farm, cycle 12, and a self-test
```

---

## Setup

### 1. Create the project

Sign up at <https://supabase.com>, create a project, pick a region near you, and
save the database password somewhere safe. It takes a couple of minutes to boot.

### 2. Run the migrations, in order

Open **SQL Editor** in the left sidebar. For each file, paste the whole contents
and press **Run**. Order matters — later files depend on earlier ones.

1. `001_schema.sql`
2. `002_views.sql`
3. `003_security.sql`
4. `004_seed.sql`

`004` ends with a query that should print the cycle's economics. Check it against
the table below before going further.

### 3. Confirm it matches the spreadsheet

| Column | Expected |
| --- | --- |
| `birds_sold` | 1425 |
| `net_lb` | 5530.1 |
| `feed_kg` | 6752.2 |
| `total_bags` | 227 |
| `revenue` | 18339.82 |
| `total_cost` | 19450.31 |
| `operating_profit` | **-1110.49** |
| `blended_price_lb` | 3.316 |
| `breakeven_price_lb` | 3.517 |
| `fcr` | 1.900 |

If these match, the database reproduces your workbook exactly and you can trust
what it tells you. **If any differ, stop and say so** — a schema that disagrees
with the sheet is worse than no schema, because it looks authoritative.

### 4. Claim your account

Sign up through the app first (or **Authentication → Users → Add user** in
Supabase). Then uncomment and run the `CLAIM OWNERSHIP` block at the bottom of
`004_seed.sql`. Until you do, RLS correctly refuses you access to everything —
that is the system working, not a fault.

To add family members, invite them **before** they sign up:

```sql
insert into farm_invites (farm_id, email, role)
select id, 'them@example.com', 'member' from farms where name = 'Our Farm';
```

Anyone who signs up without an invite gets an account with access to nothing.

---

## Security

The `anon` key is embedded in the page and is **public by design**. It is safe
only because RLS scopes every query to farms you belong to.

Two things that would undo it:

- **A table with RLS switched off.** It becomes world-readable and world-writable.
  Run the verification query at the bottom of `003_security.sql` after any schema
  change; every row must say `true`.
- **The `service_role` key in frontend code.** It bypasses RLS entirely. It
  belongs on a server, never in a page, never in this repo.

Views are created `with (security_invoker = true)` so they run as the person
querying. Without that flag a view runs as its owner and silently returns rows
RLS would have blocked. Any new view needs the same flag.

---

## What is stored, and what is not

Only inputs are stored. Anything the workbook derives with a formula is a view,
so the two cannot drift:

| Derived value | View |
| --- | --- |
| Birds alive on a given day | `v_daily_flock` |
| Dressed / net saleable weight, whole vs cut-up split | `v_cycle_yield` |
| Weekly feed requirement | `v_cycle_feed_plan` |
| Bags and feed cost per phase | `v_cycle_feed_by_phase` |
| Revenue per product line | `v_cycle_revenue_lines` |
| Full cost stack | `v_cycle_costs` |
| Profit, margin, breakeven, FCR | `v_cycle_pnl` |
| Live status for the dashboard | `v_cycle_progress` |

`birds_alive` deserves a specific mention: it is deliberately not a column. It is
placements minus cumulative mortality, so it cannot be typed into a state that
disagrees with the mortality records.

---

## Guardrails in the database

Rules enforced in Postgres rather than trusted to the interface, because the
interface is not the only way in:

- A cut-up mix totalling more than 100% is rejected on write.
- A daily check cannot record more losses than there are living birds.
- Mix shares, rates and yields are constrained to 0–1; weights and counts to
  positive numbers.
- Deleting a cycle removes its checks, feed records and health tasks; deleting a
  farm removes everything under it.

---

## A note on the numbers

The seeded cycle **loses $1,110**. That is not a bug in the seed — it is what
your assumptions produce, and the reason is an implied FCR of 1.90 against a
1.55–1.65 breed objective, with feed at 64% of total cost.

Worth resolving before building screens on top: either the week 5–6 intake
figures (170 and 200 g/bird/day) are set too high, or the birds really are
converting that poorly. Those are very different problems. `v_cycle_feed_plan`
will show you which, once a few cycles of real bag-opening data exist to compare
the plan against.

---

## Next

The schema is Phase 1 only — flock, feed, health, processing, assets. Invoicing
and the AI follow-up (Phases 2 and 3) are specified in
[`../docs/data-model.md`](../docs/data-model.md) but deliberately not built yet.
