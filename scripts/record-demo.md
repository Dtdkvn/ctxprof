# Recording the launch demo

The launch clip should be 20–25 seconds, 1440×900, and use only the deterministic fixture. It must not show a terminal containing a real credential or capture.

## Scene

1. Start from a clean temporary directory: `ctxprof demo --data .ctxprof-recording`.
2. Run `ctxprof serve --data .ctxprof-recording --port 8787`.
3. Open the local dashboard at 1440×900. Begin on **Support agent · verbose**.
4. Hover the large orange tool-result tile and click it to reveal its token share and preview.
5. Pause on the two waste signals.
6. Select **Support agent · lean** and show the reduced treemap.
7. End on the prompt-version diff: `−858` input tokens and the cost reduction.

## Capture notes

- Crop browser chrome unless the local URL helps the privacy story.
- Keep the cursor movement slow and direct; no scrolling is needed at desktop width.
- Export an optimized GIF below 8 MB plus an MP4 for social posts.
- Verify the recording contains no `.ctxprof` filesystem path with a personal username.
- Delete `.ctxprof-recording` after exporting.

The checked-in [dashboard.svg](../docs/assets/dashboard.svg) is the static README fallback and uses the same deterministic scenario.
