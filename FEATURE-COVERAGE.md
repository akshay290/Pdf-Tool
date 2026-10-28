# LocalFold 2.1 feature coverage

Updated 27 October 2026. This maps the user's 35-item checklist to the implemented local app. It does not independently establish another product's catalog or claim commercial feature parity.

**30 of 35 requested capabilities are implemented at least partially; 5 remain missing.** The interface contains **26 tools** because several checklist capabilities share a workflow. “Core present” means the described local operation exists; it does not imply every variation of that feature is supported.

The full regression run passed **100 tests, with 0 failures**. Modern and legacy Office conversions, multilingual OCR, structured exports, local APIs, and upgraded visual workflows are included. See [VALIDATION.md](VALIDATION.md) for the final test and browser evidence.

| # | Requested feature | Coverage | Actual scope and remaining boundary |
| --- | --- | --- | --- |
| 1 | Merge PDF | Core present | Combine ordinary static PDFs in the selected file order. |
| 2 | Split PDF | Core present | Download separate PDFs for entered page ranges. |
| 3 | Remove Pages | Core present | Remove pages from the thumbnail organizer before saving. |
| 4 | Extract Pages | Core present | Keep selected pages through Split or Arrange. |
| 5 | Reorder Pages | Core present | Drag thumbnails or use move controls to change output order. |
| 6 | Organize PDF | Core present | Reorder, remove, duplicate, rotate, and insert pages from additional PDFs in the visual organizer. |
| 7 | Rotate PDF | Core present | Rotate every page together or rotate individual thumbnails. |
| 8 | Crop PDF | Core present | Select a rectangle on a preview, apply coordinates to other pages, or use equal margins. Hidden content remains recoverable. |
| 9 | Copy PDF | Missing | No dedicated byte-identical file-copy operation. Reconstructing pages through Arrange is not an exact document copy. |
| 10 | PDF to Word | Partial | Recover positioned editable text, font styling, links, native tables, and embedded graphics in DOCX. Up to 100 pages, or 50 with optional OCR. Complex layout and font fidelity can vary. |
| 11 | PDF to Excel | Partial | Recover ruled tables or repeated aligned text columns as real XLSX text cells, up to 30 pages. Optional OCR makes scans searchable first. Irregular tables and recognition errors require review. |
| 12 | PDF to PowerPoint | Partial | Recreate extracted text as editable slide text over page graphics, up to 20 pages. Original PDF text is removed from backgrounds; nested text objects are supported for conversion. OCR background cleanup and complex typography remain approximate. |
| 13 | PDF to JPG | Core present | Export rendered JPG/PNG pages in a ZIP, up to 40 pages. The same tool also extracts embedded images, up to 200 pages. |
| 14 | PDF to Markdown | Partial | Infer headings, preserve formatting and links, convert detected tables, and optionally package images with document.md in a ZIP. Up to 100 pages. Semantics and reading order are inferred. |
| 15 | Word to PDF | Core present | Convert DOC and DOCX using local LibreOffice. Modern and legacy formats are verified; fonts and pagination can differ. |
| 16 | Excel to PDF | Core present | Convert XLS and XLSX using local LibreOffice. Modern and legacy formats are verified; sheet print areas and pagination affect output. |
| 17 | PowerPoint to PDF | Core present | Convert PPT and PPTX using local LibreOffice. Modern and legacy formats are verified; fonts, unsupported media, and transitions can differ. |
| 18 | JPG to PDF | Core present | Place ordered JPG/PNG uploads on A4 PDF pages. |
| 19 | HTML/Web to PDF | Partial | Print pasted HTML with inline styles, or capture public static HTTP/HTTPS URLs and allowed resources. No login session or script execution; script-dependent applications may not capture correctly. |
| 20 | PDF to PDF/A | Missing | No archival conversion or conformance validation. |
| 21 | Edit PDF | Partial | Preview pages; place text, rectangles, ellipses, lines, highlights, and images; replace supported existing text objects. Direct replacement supports horizontal, single-line fill-mode Latin text. Nested, rotated/skewed, clipping/outlined text and complex script shaping are unsupported by the editor. |
| 22 | Add Watermark | Core present | Apply text or PNG/JPG image watermarks, with opacity and image size/rotation controls. |
| 23 | Page Numbers | Core present | Add sequential page numbers with a chosen starting value. |
| 24 | PDF Forms | Partial | Inspect, fill, and flatten supported existing fields; create text, checkbox, dropdown, and radio fields on previews. No XFA designer. |
| 25 | Sign PDF | Partial | Upload, draw, or type a visual signature and position it on the page. No certificate signature, audit trail, or recipient workflow. |
| 26 | Request Signatures | Missing | No recipients, signing links, sending, reminders, or signing-status workflow. |
| 27 | Compress PDF | Core present | Target maximum size in KB/MB, plus lossless, balanced, and small presets. Target mode attempts content-preserving optimization before raster fallback and reports the actual size and whether the target was reached. Raster fallback can remove selectable text, vector detail, and interactive forms. The original is retained when it is already within target or no smaller result is found. |
| 28 | Repair PDF | Core present | Rebuild recoverable PDF structure and reopen generated output. Severely damaged sources can still fail. |
| 29 | OCR PDF | Partial | Local English, Hindi, Spanish, French, German, and Portuguese recognition, up to 50 pages in five-page chunks. Automatic segmentation supports tables and multiple blocks; form appearances are rendered. Accuracy varies with source quality. |
| 30 | Scan to PDF | Missing | No camera capture, document-edge detection, or perspective correction. Existing photographs can be uploaded through Images to PDF. |
| 31 | PDF Extract | Partial | Extract existing text, structured Markdown, detected tables, and embedded images. General file-attachment extraction is absent. Scanned text requires OCR. |
| 32 | Protect PDF | Core present | AES-256 document-open password encryption. |
| 33 | Unlock PDF | Core present | Remove encryption using the supplied correct password. No password recovery. |
| 34 | Redact PDF | Missing | No general permanent content-removal workflow. Crop, annotation, metadata removal, and individual text replacement do not provide full-document redaction. |
| 35 | Compare PDF | Partial | Extracted-text difference reports or visual pixel comparison up to 40 pages per PDF. Visual output is a ZIP with an HTML report, before/after pages, and difference images. Rendering differences and page movement can also be highlighted. |

## Local runtime and setup

- Address: [http://127.0.0.1:4173/](http://127.0.0.1:4173/). All frontend tools and APIs use the loopback server.
- Project: this outputs/localfold folder. Start the prepared Windows environment with npm start.
- Fresh setup requires Node.js 20+ and Python 3.12+. Run setup-engines.ps1; add -IncludeLibreOffice when the local Office runtime is needed. Setup installs locked dependencies and verifies downloaded OCR models and the optional Office installer.
- Installed engines run locally and work offline for uploaded documents. HTML printing uses local Edge/Chromium. Public URL capture deliberately contacts the requested public page and its allowed resources.
- Most PDF processing uses memory. Office conversion uses isolated temporary files and profiles with cleanup; headless printing uses a temporary browser profile.
- Source and engine licenses are documented in [DEPENDENCIES.md](DEPENDENCIES.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No proprietary server source was recovered.
- Public deployment, accounts, cloud integrations, billing, and production service configuration are absent.

## Fidelity and scope

Complex layouts, unusual fonts, script shaping, scanned backgrounds, and OCR errors can affect conversion results. PDF-to-Office reconstruction and structured extraction require review for the user's documents. Conversion can recover some nested PDF text even though the direct editor deliberately rejects nested objects it cannot safely replace.

The five missing checklist capabilities are a dedicated exact-copy tool, PDF/A, signature requests, camera scanning, and permanent redaction. The implemented local features do not establish full Smallpdf or iLovePDF parity.

