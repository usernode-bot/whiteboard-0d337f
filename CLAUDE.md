# whiteboard — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About whiteboard

A shared, real-time collaborative whiteboard: everyone painting on one
infinite canvas (pen/rainbow/eraser, shapes, text, emoji, images),
with pinned comment threads. Strokes are broadcast over SSE so all
viewers stay in sync.

## App-specific conventions

- **Brush shapes / premium tier.** The Shapes tool offers a catalog of
  brush shapes split into free (`line`, `rect`→"Square",
  `circle`→"Oval", `triangle`) and premium (`heart`, `prism`). The
  server in `server.js` is the source of truth for tiering and price
  (`ALL_BRUSHES`, `PREMIUM_BRUSHES`). Premium shapes are gated in the
  picker until purchased.
- **One-time premium unlock.** A single on-chain payment (via the
  Usernode bridge's `sendTransaction`, loaded from the centrally-hosted
  bridge URL — never vendored) unlocks the whole premium set
  permanently for that user. The client extracts the resolved tx id and
  POSTs it to `/api/brushes/purchase`; the server records one row per
  premium brush. Recording is idempotent (`UNIQUE(user_id, brush_id)` +
  `ON CONFLICT DO NOTHING`), so already-owned / double-submit is a safe
  no-op. Full on-chain verification of the tx is deferred — the bridge
  only resolves on confirmed inclusion, and the `tx_id` is stored for
  audit.
- **`brush_unlocks` is private** (`COMMENT … 'staging:private'`) — it's
  per-user purchase/financial data. Staging copies it schema-only, so
  `start()` seeds a `staging-user` row for the premium set under
  `IS_STAGING` to exercise the unlocked UI without a real payment.
- **Secrets.** `PREMIUM_BRUSH_PAYEE_PUBKEY` (the `ut1…` treasury that
  receives payment) is `required + private` with a `staging_default` in
  `dapp.json`; set its real value in Settings → Secrets before the PR
  deploys. `PREMIUM_BRUSH_PRICE` is a non-private integer (smallest
  on-chain unit), default `500`.
