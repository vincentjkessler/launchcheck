# Architecture

- `src/validator.js`: validates a single ZIP or HTML candidate and writes reports.
- `src/watcher.js`: detects stable new files and invokes validation.
- `src/supervisor.js`: owns the long-running worker and governed self-promotion path.
- `src/watchdog.js`: restarts a failed watcher and exits after confirmed handoff.
- `src/qaContract.js`: loads product identity and workflow contracts.
- `src/productState.js` and `src/progress.js`: retain continuity and identify regressions.
- `src/releaseGate.js`: copies evidence-backed builds into release buckets and writes receipts.
- `src/responsiveTesting.js`, `src/perfAndA11y.js`, `src/soulCheck.js`, and `src/deepInspect.js`: specialized browser and product-quality passes.
- `bin/launchcheck.js`: stable public command line.
