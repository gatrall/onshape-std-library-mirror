# Onshape Standard Library Mirror Automation

This branch contains the automation that maintains the `main` branch of
[`gatrall/onshape-std-library-mirror`](https://github.com/gatrall/onshape-std-library-mirror).

The `main` branch preserves the historical release commits inherited from
`javawizard/onshape-std-library-mirror`. This automation checks the official
[Onshape changelog](https://www.onshape.com/en/changelog/) each Friday, imports
only named standard-library releases, and reports unversioned workspace drift.

`without-versions` is retained as historical material and is not updated.

## Required secrets

- `ONSHAPE_ACCESS_KEY`
- `ONSHAPE_SECRET_KEY`

Use a dedicated read-only Onshape API key. The workflow never writes to
Onshape.

## Local verification

```bash
npm test
node tools/import.mjs --repo /path/to/main-checkout --dry-run --json
```
