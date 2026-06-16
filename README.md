# Crossroads

A decision studio that takes uncertainty seriously. Instead of tallying pros and cons and declaring a winner, Crossroads models every estimate as a range, runs a Monte Carlo simulation, and tells you the **probability** each option is best — plus the one thing worth researching before you commit.

## What makes it different

- **Uncertainty is a first-class input.** Each score is widened into a triangular distribution by your stated confidence, then simulated thousands of times.
- **Probability, not false precision.** The output is "Option A wins 72% of simulated futures," with an 80% range — not a single fake-confident number.
- **Value of information (EVPPI).** A nested Monte Carlo ranks which unknown, if resolved *before* you decide, would most improve the decision. This is the signature feature.
- **Dominance, tornado sensitivity, and a risk-attitude (utility) model** round out a genuine multi-criteria decision analysis.
- **Reproducible.** Identical inputs + seed → identical result (seeded PRNG).

## Repository layout

```
app/
  index.html            Connected web app (Supabase auth + save/load + server sim)
  research-edition.html  Standalone "PhD" version (full engine, no backend)
  simple.html            Standalone v1 (elementary weighted-scoring version)
docs/
  system-design.html     Backend architecture & design doc
  roadmap.html           Now / Next / Later product roadmap (18 months)
supabase/
  migrations/            Database schema, RLS, functions, seed (Postgres)
  functions/
    simulate-decision/   Edge Function: server-side reproducible engine
  database.types.ts      Generated TypeScript types for the client
```

## Running the app

The standalone files (`app/research-edition.html`, `app/simple.html`) work by just opening them in a browser — no backend, no install.

The connected app (`app/index.html`) talks to Supabase:

1. Deploy it as a static site (drag the file onto https://app.netlify.com/drop, or any static host).
2. In Supabase → Authentication → Providers → Email, turn **off "Confirm email"** for frictionless testing.
3. Sign up, create a decision, Save, and "Save & run on server".

The Supabase URL and publishable (anon) key are embedded in `index.html`; this is expected for a client app — Row Level Security is the security boundary, not the key.

## Backend (Supabase)

- **14 tables**, all with Row Level Security: identity/teams, the decision core (decisions, options, criteria, participants), per-participant inputs (weights, scores), simulations, decision records, and growth (templates, outcomes, subscriptions).
- **Per-participant inputs** are the pivotal design choice: a solo decision is the single-participant case, and team decisions + disagreement-surfacing reuse the same tables.
- **Edge Function `simulate-decision`** runs the verified engine server-side for authoritative/team/report runs and persists results.

To apply the schema to a fresh project: `supabase db push` (or run `supabase/migrations/` in order). To regenerate types: `supabase gen types typescript --project-id <ref> > supabase/database.types.ts`.

## The engine

The same TypeScript/JS engine runs client-side (instant, private what-ifs) and server-side (reproducible, persisted). Its math — triangular sampling, exponential utility, P(best), dominance, weight-tornado, and nested-Monte-Carlo EVPPI — is unit-tested; the server port reproduces the client headline exactly.

## Status

Beta. Connected app + backend are live. Next on the roadmap: Stripe billing webhook and shareable decision-record reports (both already accounted for in the schema).
