# Onshape Standard Library Mirror Automation

> [!IMPORTANT]
> This API-based mirror is deprecated and its scheduled workflow is disabled.
> Use
> [`h0witzer/Onshape-Standard-Library-Mirror-2-Electric-Boogaloo`](https://github.com/h0witzer/Onshape-Standard-Library-Mirror-2-Electric-Boogaloo)
> instead. That maintained mirror updates through a logged-in browser session
> and does not consume annual Onshape developer API allocation.

This branch contains the retired automation that previously maintained the `main` branch of
[`gatrall/onshape-std-library-mirror`](https://github.com/gatrall/onshape-std-library-mirror).

The `main` branch preserves the historical release commits inherited from
`javawizard/onshape-std-library-mirror`. The retired automation checked the
official [Onshape changelog](https://www.onshape.com/en/changelog/) each Friday,
imported only named standard-library releases, and reported unversioned
workspace drift.

The workflow was manually disabled on 2026-08-21. Do not re-enable it or add a
new API key; migrate consumers to the maintained mirror above.

`without-versions` is retained as historical material and is not updated.

## Required secrets

- `ONSHAPE_ACCESS_KEY`
- `ONSHAPE_SECRET_KEY`

Use a dedicated read-only Onshape API key. The workflow never writes to
Onshape.

Onshape applies an account-level annual API-call allowance. For each new named
release, the importer compares canonical element microversion IDs with the
previous named version, copies unchanged files from the validated checkout, and
downloads only changed or added elements. A no-op weekly check uses four
Onshape calls; it does not redownload the 270-element library.

## Local verification

```bash
npm test
node tools/import.mjs --repo /path/to/main-checkout --dry-run --json
```
