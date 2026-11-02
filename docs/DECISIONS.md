# Decisions (ADR log)

Short-form ADRs: context → decision → consequences. Newest entries may appear
under the newest section number; numbers are stable and never reused.

Test-only constants are flagged where relevant:

- `cp001` (station / charge point id) and `DEADBEEF` (RFID idTag) are
  **test-only fixtures** for the Phase 0 smoke test. They must never be used in
  a real environment. Our production station naming convention is planned for
  Phase 2.

## Runtime and tooling

### ADR-0001: Run on Node 24 LTS · vitest 5 · pnpm 10 exact pin

- **Context.** The PRD (docs/PRD.md, section 4) originally said "Node 20+ LTS".
  Node 20 reached end-of-life in April 2026, and the current test-runner
  generation (vitest 5) requires Node `^22.12 || ^24 || >=26`. CitrineOS
  v2.1.0 itself requires Node 24.16+ for source builds (we consume its
  published images, but staying on the same LTS reduces drift).
- **Decision.** Our monorepo runtime is **Node 24 LTS, exact-pinned
  24.22.2** (`.nvmrc`, `package.json` `engines`, and the CI Node version in
  `.github/workflows`, which reads `.nvmrc`). Vitest is pinned to the latest
  stable 5.x at adoption time (`5.0.5`). pnpm is exactly pinned via
  `packageManager` (`pnpm@10.30.3`).
- **Consequences.** "20+" from the PRD is superseded by an exact-hig∓er floor;
  the PRD runtime line was updated accordingly. Environments running Node 20/22
  must upgrade before running this repo's scripts.

### ADR-0002: TypeScript pinned to 5.9.3 (not 7.x)

- **Context.** TypeScript 7.0.2 is the current `latest` on npm
  (2026-11-02), but typescript-eslint 8.72.1 declares peer support only for
  `typescript >=4.8.4 <6.1.0`.
- **Decision.** Pin TypeScript **5.9.3** (newest 5.x) so that
  `typescript-eslint` type-aware linting stays inside supported ranges.
- **Consequences.** Revisit when typescript-eslint publishes support for
  TypeScript ≥7; then bump TypeScript and re-pin. Until then, language
  features from TS 6/7 are unavailable to this repo.

### ADR-0003: Reproducible installs — exact versions and frozen lockfile

- **Context.** Contract rules: no dependency drift between machines; CI must
  test what got committed; hooks may be bypassed locally, so CI must run the
  same checks.
- **Decision.** (1) All dependency versions are recorded **exact** (no `^`
  ranges; `.npmrc` sets `save-exact=true`, and existing ranges were rewritten
  to exact). (2) `pnpm-lock.yaml` is committed. (3) CI installs with
  `pnpm install --frozen-lockfile` (root script `install:ci`), failing the
  build if the lockfile is out of sync with `package.json`. (4) `packageManager`
  is an exact pnpm version, so Corepack and CI agree on the package manager.
- **Consequences.** Upgrade PRs must also commit the regenerated
  `pnpm-lock.yaml`; CI blocks unnoticed drift.

## Infrastructure

(Infrastructure ADRs — CitrineOS pin, compose strategy, ports — are added with
the commits that make them real.)
