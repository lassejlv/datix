# Dither Kit

Installed from [Dither Kit](https://www.tripwire.sh/dither-kit) with its official CLI (`area-chart` + `core`, version 0.1.0). Registry provenance and upstream hashes are retained in the root `dither-kit.json`; Bun locks the Motion and D3 dependencies.

Local integration adjustments:

- Cartesian charts support keyboard inspection (arrows, Home, End, Escape) and an accessible name. Tooltips announce their content and measure their bounds to stay inside narrow charts.
- A single observation paints a centered marker, without inventing a continuous area across the time axis.
- X-axis ticks include both endpoints and avoid clipping their labels.
- Series support an optional palette seed; the traffic chart tracks the system theme so its monochrome fill stays legible in light and dark mode.
- Axis/tooltip text and borders use the application's Tailwind theme.

Check these adjustments when updating the vendored source. `scripts/browser-smoke.ts` verifies painted canvas pixels, keyboard tooltips, and the single-day marker against real report data.
