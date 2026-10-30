# LocalFold validation history

This records checks completed during development. Generated logs, screenshots and sample PDF outputs are retained in the local workspace and excluded from the source repository. Run `npm test` after installing the dependencies to check your environment.

## Compression update — 30 October 2026

Only compression and its integration changed. Added target-size raster image compression and the HEIC/HEIF codec, plus longer-PDF processing and embedded-image downsampling before page rasterization. Existing PDF presets and unrelated operations retain their previous contracts.

- Full regression run: **138 passed, 0 failed**. Final compression/API/frontend run after animation and interface adjustments: **61 passed, 0 failed**. Together these cover **141 unique current test names**, with no missing tests. The runs overlap and are not 199 distinct tests.
- A synthetic PNG was uploaded through the browser and downloaded as a valid WebP: **1,187,975 → 115,558 bytes**, meeting a 120,000-byte maximum at the original **1280 × 960** dimensions.
- A synthetic PDF compressed **3,705,621 → 346,386 bytes**, meeting a 350,000-byte maximum using embedded-image downsampling (scale 0.7, JPEG 53). Selectable text was verified and the final output rendered with Poppler. Text/forms/page placement are covered by the dedicated regression fixture.
- Real-codec regressions cover HEIC/HEIF, 12 common raster input formats, transparency, EXIF orientation/ICC, GIF timing/finite and play-once loops, APNG poster behavior, multipage TIFF, 16-bit grayscale precision, 48 MP inputs and honest impossible targets. Unsupported playback-changing conversions reject clearly.
- `pip check`, JavaScript/Python syntax checks and whitespace checks (allowing existing Windows CRLF) passed. Existing package versions were retained; only pillow-heif 1.8.1 was added. Its OSV check returned no matching package advisory records at verification time. Native bundled-library security and the previously recorded readiness audit are separate concerns.

Saved logs, synthetic visual evidence and the update summary are in the sibling `../compression-update-2026-10-30/` folder. Earlier validation records follow.

## Target-size compression — 28 October 2026

- **54 focused checks passed:** 48 API, frontend and existing-PDF checks, plus six target-compression engine cases. These checks overlap earlier regression coverage.
- Cases verify files already below target, lossless cleanup, image recompression retaining selectable text and form fields, raster fallback, unreachable targets, page limits and strict size validation.
- A real browser sample was compressed from **3,705,621 bytes to 493,923 bytes** for a **500,000-byte target**, entered as **0.5 MB**. Independent PDF inspection confirmed its one page was retained.
- The sample used raster fallback at 144 DPI and JPEG quality 57. The interface reported the loss of selectable text and forms.
- An unreachable maximum is reported honestly. The search never goes below 72 DPI/JPEG quality 35 and does not pad results to an exact size. Raster fallback supports up to 40 pages.

## Core upgrade — 24–27 October 2026

- The full regression run completed with **100 passed, zero failed and zero skipped** in approximately eight minutes 44 seconds.
- After final interface fixes, a separate frontend run completed with **32 passed and zero failed**. This overlaps the full regression run; the two runs are not 132 unique tests.
- Coverage includes actual PDF bytes, local APIs, modern and legacy Office conversion, editable PowerPoint text, positioned Word content, ruled and borderless Excel tables, structured Markdown, English and French image-only OCR, OCR chunks, encryption/unlocking, visual comparison, HTML printing, public URL capture, form creation/filling and text-object replacement.
- Browser checks exercised cross-file page organization, drag and drop, individual rotation, drawn crop rectangles and real existing-text replacement with downloaded PDF validation.
- Crop-area readiness, image/signature proportions, editor-image fitting and typed-signature preview sizing received focused regressions.
- All six OCR model checksums matched the pinned official tessdata_fast revision `87416418657359cb625c412a48b6e1d6d41c29bd`.
- The Windows setup script passed a syntax check. A clean reinstall over a fresh machine was not part of these recorded checks.

## Runtime and scope

The local server was verified on `127.0.0.1:4173`, and the health endpoint confirmed `ok: true` and `service: LocalFold`. A new clone must install the engines described in [README.md](README.md); historical validation is not a guarantee for every input document or machine.

The app covers at least part of 30 requested capabilities through 26 tools. Dedicated exact-copy, PDF/A conversion and validation, signature requests, camera scanning and permanent redaction remain outside this MVP. Complex text transforms, nested existing-text editing, complex-script shaping and arbitrary layout reconstruction remain limited. Visual signatures are not certificate signatures.

Public hosting, accounts, billing and production deployment configuration are not included. See [feature coverage](FEATURE-COVERAGE.md) and [dependency notices](DEPENDENCIES.md).
