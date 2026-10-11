# ASCII Forge

Turn any photo into ASCII art, entirely in your browser. One HTML file, zero
dependencies, no uploads, no network calls at runtime.

**Live:** https://nwfella.github.io/ascii-forge/

The reason it exists: most image→ASCII tools binarise a photo and hand you mush.
Dark, grainy, low-light frames are the worst case — the subject and the background
both land in the bottom fifth of the tonal range, so the output is undifferentiated
static. ASCII Forge has a tone pipeline built for exactly that, and it reports a
**measured tonal-fidelity number** so you can see what the shaping cost you.

## What it does

- **Drop, paste (`Ctrl`+`V`), pick a file, or capture a frame from your webcam** — PNG, JPEG,
  WebP, GIF, BMP. Everything happens locally; nothing is uploaded, including camera frames
  (the stream goes straight into a canvas, and the camera is released as soon as you
  capture or stop, so the indicator light goes out).
- **Auto-tuned on load** from the image's own histogram: black point, white point and
  gamma are derived per image, then normalised so the darkest character is genuinely
  blank and the brightest reaches the top of the ramp.
- **Manual tone control** — black-point crush, white point, sigmoid contrast, gamma,
  median denoise, unsharp sharpening after downsampling.
- **5 ramps** (69-level classic, 10-level standard, Unicode blocks, minimal, binary) plus
  a custom ramp field.
- **Floyd–Steinberg dithering** for a halftone-print look.
- **Colour mode** — each character takes the colour of the pixel it stands for.
- **Presets**: Dim photo, Faithful, Punchy, Newspaper, Blocks.
- **Exports that cannot disagree with the preview.** The `.txt`, `.svg`, `.html`, `.png`
  and ANSI-clipboard outputs are all built by the same functions that draw the preview.
  A gate asserts byte-equality.
- **Responsive**, and the preview auto-fits the pane width at any column count.

## The dim-photo pipeline

Measured on the reference low-light portrait (283×374, frame mean 54/255):

| | tonal match | subject detail (sd) | subject characters | background blank |
|---|---|---|---|---|
| faithful (no shaping) | 1.000 | 4.78 | 34 | 0% |
| hand-tuned preset | 0.978 | 6.14 | 50 | 33% |
| **auto-tuned (default)** | **0.981** | **9.41** | **60** | 25% |

"Tonal match" is the Pearson correlation between the luminance the characters imply
and the luminance of the untouched photo, sampled on the same grid. 1.00 means the
characters reproduce the original tones exactly. Shaping the tones always costs
fidelity — the app shows you the number rather than pretending otherwise.

Auto-tuning wins on both axes, which is why it is the default and the fixed preset is
just a chip.

## Run it

No build step, no server:

```
open index.html            # macOS
start index.html           # Windows
xdg-open index.html        # Linux
```

It also works over `file://` — there is nothing to fetch.

## Verify it

Two gates, both zero-dependency. The first is Node-only, the second drives real Chrome
over the DevTools Protocol (Node's built-in `fetch` and `WebSocket`, no puppeteer).

```
node scripts/verify_app.js        # 80 assertions, no browser needed
node scripts/browser_check.js     # 43 assertions in real Chrome
node scripts/browser_check.js --shot=artifacts/app.png --cam-shot=artifacts/camera.png
CHROME_PATH=/path/to/chrome node scripts/browser_check.js
```

`verify_app.js` extracts the block between the `CORE-START` / `CORE-END` markers in
`index.html`, evaluates it in Node, and asserts on real numbers — resampler weights,
LUT monotonicity, dither mean preservation, Pearson edge cases, output geometry at
extreme aspect ratios, and the end-to-end claim that shaping a dim frame expands
subject contrast while costing measurable fidelity. It ships a synthetic "dim photo"
whose profile matches the reference photo, so the gate fails if the pipeline stops
actually helping dim frames.

`browser_check.js` loads the real app, drives it through the exposed `window.AsciiForge`
hook, and checks what actually rendered: that the `.txt` export equals the preview, that
colour-mode `textContent` still equals the raw grid, that the layout does not overflow at
390 / 1024 / 1500 px, that a 3×3 white image does not wedge it, that a webcam frame is
captured, converted and the camera released, and that nothing throws.
If no browser is found it prints `SKIPPED` and exits 0; add `--require` in CI to make
that a failure.

The webcam path is gated for real: the browser check launches Chrome with
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, so a synthetic camera
supplies 1280×720 frames with nobody in front of a lens, and the gate asserts that capture
produces a converted grid, that the stream is stopped afterwards, and that the button
returns to its idle label. (`--auto-accept-camera-and-microphone-capture` looks like the
right flag for this but makes Chrome exit before it opens the debugging port — leave it
out.)

## Architecture

`index.html` is the whole product — CSS and JS inline. Inside it, the block between the
`CORE-START` and `CORE-END` markers is pure, DOM-free image maths:

```
toGray → median3 → levelLut → sigmoidLut → gammaLut → stretchLut
       → resample (Lanczos-3, separable) → unsharp → quantize | ditherFS
       → levelsToText
```

The ramps and the presets live in that block too, so the UI labels and the test gate read
the same data as the renderer and cannot drift. Everything below the `CORE-END` marker is
DOM and is covered by the browser gate instead.

`tonalMatch` is computed against a resampling of the *untouched* source, which is why the
faithful render scores 1.00 by construction and every shaped render scores below it.

## Privacy

No analytics, no telemetry, no external requests — `verify_app.js` greps for `fetch(`,
`XMLHttpRequest`, CDN hostnames and offsite `src`/`href` values and fails the build if any
appear. The demo image is drawn with canvas at runtime rather than shipped as a file.

## Licence

MIT — see [LICENSE](LICENSE).
