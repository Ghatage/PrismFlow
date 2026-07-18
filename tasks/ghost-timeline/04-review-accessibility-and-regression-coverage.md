# Ghost timeline accessibility and regression coverage

Status: complete

## Goal

Make the ghost timeline dependable as a daily review surface. Lock down the
visual distinction, keyboard behavior, persistence, and browser interactions
that are easy to regress as generation and character features grow.

## Dependencies

- `01-review-session-model.md` through `03-stale-proposal-reconciliation.md`.
- Existing Node test suite and Playwright browser smoke harness.
- Existing timeline ghost styles and inspector markup.

## Coverage

Add focused tests for:

- serialized pending, accepted, rejected, stale, and rebased proposals;
- ghost item roles and stable accessible names for add, move, trim, replace,
  and remove operations;
- keyboard selection, queue navigation, preview entry/exit, and Escape;
- drag revision creating a new proposal while leaving accepted clips intact;
- browser reload preserving review history and pending proposals; and
- no-console-error smoke coverage across the complete review loop.

Where markup is changed, use semantic buttons and labels rather than relying
on color alone. Add explicit status text or accessible descriptions for
pending, stale, accepted, rejected, and preview states. Keep test fixtures
deterministic and use the fake generation adapter; paid FAL calls are not part
of this plan.

## Acceptance criteria

- Unit tests cover the review model, reconciliation outcomes, and persistence
  boundaries.
- Browser tests exercise mouse and keyboard review paths.
- The test suite passes with the real server adapter disabled or fake-backed.
- `npm test` remains green and `git diff --check` reports no whitespace errors.
- The plans' behavior is documented in concise UI-facing comments or README
  notes where a future contributor would otherwise infer the contract.

## Non-goals

- No snapshot test that hardcodes the entire page markup.
- No paid provider requests.
- No final export/render validation.
