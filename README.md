# LocalFold 2.1

LocalFold is a free, self-hosted PDF workspace for Windows localhost. Its **28 tools implement at least part of 30 capabilities** in the user's 35-item checklist. See [FEATURE-COVERAGE.md](FEATURE-COVERAGE.md) for each capability's scope and the five remaining gaps. It does not claim complete iLovePDF or Smallpdf feature parity.

Open [http://127.0.0.1:4173/](http://127.0.0.1:4173/) after starting the app. The frontend and document APIs use the same loopback server. Uploaded documents are processed on the machine hosting LocalFold, with no paid document API, account, analytics, or remote frontend assets. Public webpage capture contacts the public URLs and resources you choose; ordinary document processing works offline once the engines are installed.

## Run on Windows

The repository contains the application source, tests, dependency lockfiles, setup scripts, and license notices. Downloaded engines, installed dependencies, local document outputs, and screenshots are not committed. If the engines are already installed, start the app from PowerShell in this folder:

~~~powershell
npm start
~~~

For a fresh installation, install **Node.js 20 or newer** and **Python 3.12 or newer**, then run:

~~~powershell
.\setup-engines.ps1
npm start
~~~

The setup script installs locked Node and Python dependencies and downloads the six official OCR models with checksum verification. To also download and extract the pinned LibreOffice runtime into this project, use:

~~~powershell
.\setup-engines.ps1 -IncludeLibreOffice
~~~

Initial setup needs internet access. Later processing uses installed local engines. HTML and webpage printing also require an installed Edge or Chromium browser. Setup requires no subscription or PDF service credentials.

The default address is 127.0.0.1:4173; PORT can select another local port. Optional executable overrides are LOCALFOLD_PYTHON, LOCALFOLD_BROWSER, and LOCALFOLD_LIBREOFFICE. See [DEPENDENCIES.md](DEPENDENCIES.md) for versions, runtime folders, license notices, and source information. Public hosting, accounts, billing, and production deployment are not configured.

## The 28 tools

| Area | Tools and working scope |
| --- | --- |
| Pages | Merge, Split, Rotate, Arrange, Crop, Watermark, Page numbers, Images to PDF. Arrange uses thumbnails and drag and drop, supports removal, duplication, individual rotation, and insertion from other PDFs. Crop supports a selected rectangle or equal margins. Watermarks use text or an image. |
| Editing and signatures | Edit PDF, PDF forms, Sign PDF. Place text, shapes, highlights, and images on a page preview; replace supported existing text objects. Create and fill supported form fields. Upload, draw, or type a visual signature and position it on the page. |
| Maintenance and security | Compress, Repair, Flatten, Remove metadata, Protect, Unlock. Compression accepts a target maximum size in KB or MB, alongside lossless and raster presets. Protection uses AES-256; unlocking requires the correct existing password. |
| Images | Compress images, Resize images. Keep a maximum file size, set pixel or print dimensions, and preserve supported transparency and animation locally. |
| Extraction and comparison | PDF to images, Extract text/Markdown, Compare PDFs. Export rendered pages or embedded images in a ZIP. Download text or structured Markdown with optional image assets. Compare text or create a visual comparison ZIP with an HTML report and difference images. |
| Conversion | HTML/Web to PDF, Office to PDF, PDF to Word, PDF to PowerPoint, PDF to Excel. Local LibreOffice handles DOC/DOCX, XLS/XLSX, and PPT/PPTX. PDF exports recover Word layout, editable slide text, and detected spreadsheet tables. |
| OCR | Make scans searchable in English, Hindi, Spanish, French, German, or Portuguese, up to 50 pages. PDF-to-Office tools can run OCR before conversion. |

## Compress to a target size

The Compress PDF form starts with a maximum-size input. Choose KB or MB, enter the size required by your upload limit, and compress. Units are decimal: 500 KB and 0.5 MB both mean 500,000 bytes.

Target mode preserves an original already below the maximum, tries lossless cleanup, then recompresses eligible embedded images while retaining text and forms. If needed, it tries a bounded raster search with a minimum of 72 DPI and JPEG quality 35. Raster fallback converts pages into images and removes selectable text and interactive forms. Target mode now processes raster pages individually, without the previous 40-page cutoff. It limits each page to 12 million rendered pixels and a candidate to 120 million pixels, with a 70-second/24-trial search budget. Balanced/Small presets retain their separate 40-page limit.

The download reports its actual size and whether it reached the maximum. An impossible target produces a clearly marked closest available result, never a false success or padded file. Valid targets range from 1,000 to 16,777,216 bytes; results never intentionally exceed the input size. Preset compression levels remain under Advanced.

## Compress images to a target size

Choose **Compress images**, upload one image (up to 16 MiB), enter a maximum in decimal KB/MB and choose Auto or JPEG, PNG, WebP or AVIF output. Common raster inputs include JPEG, PNG/APNG, WebP, AVIF, HEIC/HEIF, GIF, BMP, TIFF, ICO and JPEG 2000. Additional installed raster decoders are supported; SVG/vector and camera RAW files are not supported universally. PSD reads the merged raster composite, without editable layers.

The compressor keeps an original already within the maximum, then tries pixel-preserving encodings and full-resolution quality searches before proportional Lanczos resizing. Auto compares tested decoded candidates for fidelity and retains transparency and supported animation/pages. Requests that would discard transparency or frames are rejected. Animation format changes are refused when looping, timing or poster behavior cannot be preserved. Use Auto for multipage TIFF/HEIF. Animated AVIF is retained unchanged when the installed decoder cannot expose its loop setting reliably; a missed target is reported honestly.

Image-only limits are 50 million pixels per frame, 60 million across frames, 30,000 pixels per side, 120 frames/pages, 52 encoding attempts and a 65-second search budget. JPEG/WebP/AVIF quality search has a floor of 50; resizing stops before a 64-pixel long edge. Results report actual bytes, target status, dimensions, format and resizing. An impossible maximum returns the closest tested result; no universal target or quality guarantee is claimed. Auto avoids output inflation; an explicitly requested format conversion may be larger if the target cannot be reached.

Re-encoding applies EXIF orientation, retains supported color profiles and removes EXIF/GPS metadata. A byte-identical original retains its metadata. Format conversion can change bit depth and specialized format features. This addition does not alter the file rules of other tools.

## Resize images

Choose **Resize image**, upload one supported raster image (up to 16 MiB), and enter the requested width and height in pixels or centimetres. Centimetre dimensions use a selectable print resolution from 36 to 1200 DPI. Keep the aspect ratio or request exact dimensions, then choose Auto or JPEG, PNG, WebP or AVIF output. An optional maximum file size changes the encoding search only: output pixel dimensions stay fixed, and an unreachable target is reported without silently shrinking the image. Supported animation and multipage inputs retain their frames or pages when their output format permits it.

## Conversion details and limits

- **Word:** positioned editable text, font sizes, colors, bold/italic styling, links, native tables, and embedded images; up to 100 pages, or 50 when OCR is enabled.
- **PowerPoint:** editable extracted text over reconstructed page graphics, up to 20 pages. Original PDF text objects are removed from the rendered background to avoid duplicate visible text. Scanned backgrounds require approximate cleanup after OCR.
- **Excel:** ruled tables first, then repeated aligned text columns, up to 30 pages. Source cell text remains literal, including strings resembling formulas. Documents without enough table structure receive a clear error.
- **Markdown:** inferred headings, bold/italic text, links, and detected tables; optional ZIP containing document.md and image assets. Structured extraction supports up to 100 pages; plain text supports up to 200.
- **Images:** rendered JPG/PNG pages for up to 40 pages. Embedded-image extraction supports up to 200 pages, with per-image and output limits.
- **Comparison:** text difference reports and visual comparison for up to 40 pages per PDF. Visual reports compare rendered pixels at 72 DPI; page movement and rendering differences can also be highlighted.
- **OCR:** six installed language models, up to 50 pages, rendered in chunks of five. Automatic segmentation handles multiple blocks and tables, with a sparse-text retry when the first pass finds little or no text. PDF form appearances are included.
- **Web capture:** pasted HTML supports inline CSS and embedded data resources. Public HTTP/HTTPS URL capture can fetch static page resources. It does not use login sessions or run page scripts; authenticated pages and applications requiring scripts may not capture correctly.

The normal upload limit is 16 MB per file, 48 MB combined per task, and 12 files for multi-file tasks. The interface shows operation-specific page limits. Most outputs are limited to 64 MB, with stricter limits for some operations. Unlock password-protected inputs before ordinary editing.

## Practical boundaries

PDF-to-Office output reconstructs available content. Complex layouts, overlapping text, reading order, unusual fonts, and script shaping can differ from the source. OCR accuracy depends on language selection and scan quality. Font substitution and image-based lettering can limit editability.

Existing-text replacement supports direct, horizontal, single-line fill-mode text objects and Latin text with common punctuation. Nested Form XObject text, rotated/skewed text, clipping/outlined text, and complex script shaping are unsupported by that editor. Unsupported objects are identified in the interface. Conversion can recover some nested text even when direct editing cannot replace it.

Crop changes the visible page boundary and leaves hidden content recoverable. Text replacement edits selected text objects, and metadata removal clears document properties; neither provides general redaction. Raster compression can remove selectable text, vector detail, and interactive forms. Page-copying operations can lose document-level structures such as bookmarks or forms. Changing a signed PDF can invalidate its signature.

Five checklist features remain absent: **a dedicated exact-copy tool, PDF/A conversion and validation, signature requests, camera scanning, and permanent redaction**. Visual signatures do not provide certificate signing, signing links, or an audit trail. Form tools do not implement an XFA designer.

## Validation

The 30 October compression update passed **141 unique checks** across a full 138-test regression run and a final 61-test focused run covering later compression adjustments; these runs overlap. Both completed with zero failures. Tests include existing PDF tools, real Office conversions, OCR, new image codecs, transparency, animation playback/posters, high-resolution inputs, target-size output and text/form preservation. Synthetic image upload/download was verified in the browser; final PDF output was reopened, text-checked and rendered with Poppler. Earlier browser validation also covered organization, crop and supported text replacement.

See [VALIDATION.md](VALIDATION.md) for the final recorded test and browser evidence. To rerun the suite in the installed environment:

~~~powershell
npm test
~~~

## REA investigation and license

The official rea-agents 6.7.0 CLI inspected four public iLovePDF page states during development. LocalFold is independently implemented using open-source libraries; it does not contain iLovePDF's private server code, branding, or proprietary processing services. REA is a development reference tool and is not required to run the app.

LocalFold source uses the MIT license. Dependency licenses remain applicable, including LibreOffice's separate license and source-availability requirements. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [DEPENDENCIES.md](DEPENDENCIES.md).
