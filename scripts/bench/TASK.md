Build the `ledger` CLI in this repository.

1. Fix `src/parse.js` so that `npm test` passes. Do NOT edit `tests/parse.test.js`.
   `parseTransactions(text)` must return `{ transactions, skipped }`:
   - skip the header row; trim whitespace around every field;
   - `amount` is a decimal number (keep decimals), negative amounts are refunds;
   - a malformed row (wrong number of columns, non-numeric amount, or blank) is skipped and counted in `skipped`, never thrown.

2. Create `src/ledger.js` exporting `summarize(transactions)` which returns
   `{ months: [{ month, total, topCategory }] }`:
   - `month` is `YYYY-MM` taken from the date, sorted ascending;
   - `total` is the sum of amounts in that month (refunds reduce it), rounded to 2 decimals;
   - `topCategory` is the category with the highest total in that month.
   - An empty input returns `{ months: [] }`.

3. Create `bin/ledger.js` so that `node bin/ledger.js summary <file> [--json]` works:
   - `--json` prints the exact `summarize` result as JSON;
   - without `--json` prints one line per month with the month, total and top category;
   - an empty file (header only or no rows) prints `no transactions` and exits 0;
   - a missing file prints an error to stderr and exits 1;
   - if rows were skipped, print `skipped N malformed rows` to stderr.

4. Add tests for `summarize` and for the CLI in `tests/`. `npm test` must pass.

5. Commit the work with the message `feat: ledger summary`.

Constraints: no new dependencies (package.json must not gain `dependencies` or `devDependencies`), ES modules only, no files outside `src/`, `bin/` and `tests/`, do not touch `data/`.
