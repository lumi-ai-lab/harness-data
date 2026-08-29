# Pi html-report adapter

This directory contains the Pi adapter maintained alongside the Harness Data Codex Plugin. It reuses the shared html-report kernel and data contracts; it is not a separate Marketplace source for the Codex Plugin.

The shared Plugin source is:

```text
plugins/harness-data/
```

The adapter must receive explicit resource, data, workspace, state, and secret roots from its host. It must not infer a product root from the current working directory or write state into a Plugin cache.

Build and verify locally:

```bash
npm --prefix plugins/pi-html-report run build
npm --prefix plugins/pi-html-report run verify
npm --prefix plugins/pi-html-report test
```
