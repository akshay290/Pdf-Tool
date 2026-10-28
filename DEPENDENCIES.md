# Local processing engines and licenses

Inspected on 24 October 2026. LocalFold's original application source uses the MIT license in `LICENSE`. Third-party engines retain their own licenses and notices. The installed dependencies perform the document operations locally; no paid PDF API is required.

## JavaScript dependencies

`package-lock.json` records installed versions, including transitive dependencies. Preserve the original license files and notices in `node_modules` when redistributing those packages.

| Component | Installed version | License | Source / purpose |
| --- | --- | --- | --- |
| pdf-lib | 1.17.1 | MIT | [Source](https://github.com/Hopding/pdf-lib), PDF creation and page manipulation |
| Tesseract.js | 7.0.0 | Apache-2.0 | [Source](https://github.com/naptha/tesseract.js), local OCR and searchable PDF output |
| Tesseract.js core | 7.0.0 | Apache-2.0 and supplied native notices | [Source](https://github.com/naptha/tesseract.js-core), packaged OCR WebAssembly |
| Playwright core | 1.62.1 | Apache-2.0 | [Source](https://github.com/microsoft/playwright), local HTML rendering |

OCR models for English (`eng`), Hindi (`hin`), Spanish (`spa`), French (`fra`), German (`deu`), and Portuguese (`por`) live in `runtime/tessdata`, from the official [tessdata_fast project](https://github.com/tesseract-ocr/tessdata_fast). Their Apache-2.0 license is retained as `runtime/tessdata/LICENSE`. The application sets local worker, core, and model paths, so processing does not request an OCR model from a CDN.

On 27 October 2026, all six model checksums were verified against upstream revision `87416418657359cb625c412a48b6e1d6d41c29bd`. `setup-engines.ps1` pins this revision and checks the models against `python/ocr-models.json`. Copies of 62 installed JavaScript and Python dependency notice files are also preserved in `licenses/`.

Playwright browser binaries have their own license files, separate from Playwright's license. The existing Windows browser cache supplies the local Chromium installation; browsers are not embedded in LocalFold's source. Retain the browser's original notices if you package a browser with a distribution.

## Python dependencies

`python/requirements.txt` pins the direct dependencies. `setup-python.ps1` installs them in the project's `.venv`. Python is selected from `LOCALFOLD_PYTHON`, the local virtual environment, the available bundled runtime, or the system Python, in that order.

| Component | Installed version | License | Source / purpose |
| --- | --- | --- | --- |
| pypdf | 6.10.0 | BSD-3-Clause | [Source](https://github.com/py-pdf/pypdf), compression, encryption and PDF structure |
| pypdfium2 | 5.14.0 | Apache-2.0 / BSD-3-Clause plus PDFium dependency notices | [Source and licensing](https://github.com/pypdfium2-team/pypdfium2#licensing), rendering and text extraction |
| Pillow | 12.3.0 | MIT-CMU plus bundled image library notices | [Source](https://github.com/python-pillow/Pillow), image encoding |
| ReportLab | 4.4.9 | BSD plus supplied font notices | [Project](https://www.reportlab.com/opensource/), generated PDF content |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause plus bundled native notices | [Source](https://github.com/pyca/cryptography), AES encryption support |
| python-docx | 1.2.0 | MIT | [Source](https://github.com/python-openxml/python-docx), editable Word text exports |
| python-pptx | 1.0.2 | MIT | [Source](https://github.com/scanny/python-pptx), slide exports |
| openpyxl | 3.1.5 | MIT | [Project](https://openpyxl.readthedocs.io/), Excel table exports |
| pdfplumber | 0.11.9 | MIT | [Source](https://github.com/jsvine/pdfplumber), table detection |
| olefile | 0.47 | BSD, with supplied legacy PIL notices | [Source](https://github.com/decalage2/olefile), legacy Office container inspection |

Installed supporting Python packages include cffi 2.1.1 (MIT-0), charset-normalizer 3.5.2 (MIT), et_xmlfile 2.0.0 (MIT), lxml 6.1.3 (BSD-3-Clause with bundled XML library notices), pdfminer.six 20251230 (MIT), pycparser 3.12 (BSD-3-Clause), typing_extensions 4.16.0 (PSF-2.0), and XlsxWriter 3.3.0 (BSD-2-Clause). Python and packaging tools have their own supplied licenses.

For the exact installed versions, preserve the package license files under `.venv/Lib/site-packages/*dist-info/licenses` and any package-level notices. In particular, the pypdfium2 wheel includes PDFium and dependency license texts under its `licenses/data/windows_x64/BUILD_LICENSES` directory. Its binding license alone does not cover every compiled dependency. Preserve the complete notices supplied with Pillow, cryptography, lxml, and ReportLab when packaging their wheels or runtime files.

## LibreOffice runtime

The separate Windows runtime in `runtime/libreoffice` is LibreOffice 26.8.1. Its core is MPL-2.0, and the distribution contains additional components under other licenses; it is not an MIT, BSD, or Apache-only dependency. LocalFold invokes its command-line conversion engine as a separate application. Its original `license.txt`, `LICENSE.html`, `NOTICE`, credits, and component notices remain in the runtime folder.

Official [licensing information](https://www.libreoffice.org/licenses/) describes the applicable terms. Obtain the corresponding upstream source through the [official source download page](https://www.libreoffice.org/download-other/#source-code-and-sdk) or [source repository](https://git.libreoffice.org/core). If distributing the runtime, preserve those notices and tell recipients how to obtain its corresponding source under the applicable licenses.

The official [Windows download metadata](https://download.documentfoundation.org/libreoffice/stable/26.8.1/win/x86_64/LibreOffice_26.8.1_Win_x86-64.msi.mirrorlist) reports a 374,870,016-byte installer with SHA-256 `c6298b10cfa1748bcbedad94c62ce771e240e5021bfd6d7a967cd571b04b5312`. The runtime was extracted for this local project. Office conversion fidelity depends on document formatting and available fonts.

## Conversion limits

- Word export recovers positioned editable text frames, font sizes, colors, bold/italic styling, links, native tables, and embedded image graphics, up to 100 pages. Source page dimensions are retained. Font substitution, overlapping elements, rotated text, and complex reading order can affect fidelity. Whole scanned page images are omitted behind recovered text to prevent duplicate glyphs; OCR should run before converting image-only text.
- PowerPoint export removes PDF text objects from the rendered background and recreates their extracted text as editable, positioned text boxes over page graphics, up to 20 pages. Font sizes, colors, styling, links, and page aspect ratios are retained where extractable. OCR scans use approximate background cleanup around recovered text; complex scanned backgrounds and diagrams need review. Unextractable graphical lettering remains graphical.
- Excel export tries ruled tables first, then repeated aligned text columns, up to 30 pages. It writes real text cells and rejects documents without enough tabular structure. OCR can make scanned cells selectable; irregular tables and reading order still need review. Formula-looking PDF strings remain literal text.
- Markdown export infers headings from font sizes, preserves detected tables, links, and inline bold/italic styling, and can bundle embedded graphics with `document.md` in a ZIP. Heading levels and reading order are inferred from PDF geometry.
- OCR supports printed text in six installed languages and up to 50 pages per task. Pages are rendered in chunks of five to bound image memory. Automatic page segmentation handles tables and multiple text blocks; sparse text is retried when the first pass is empty or has very low confidence. PDF form appearances are included in rendering. Recognition accuracy depends on scan resolution, language selection, and document typography.
- Lossless compression keeps PDF content; optional raster compression changes pages into images and can remove selectable text, interactive forms, and vector detail. Size reduction depends on the input.
- Unlocking uses the supplied document password. Cryptographic PDF signatures, trusted signing certificates, PDF/A conformance, and advanced layout recovery require additional specialized work.

These conversions use independent local reconstruction and do not promise identical output to proprietary commercial conversion engines. The project does not use Ghostscript, PyMuPDF, or pdf2docx. See `THIRD_PARTY_NOTICES.md` for the original pdf-lib notices.

The layout implementation follows the public [pdfplumber text and table APIs](https://github.com/jsvine/pdfplumber), [PDFium object removal and rendering API](https://pypdfium2.readthedocs.io/en/stable/python_api.html), [Word text-frame specification](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.frameproperties), [Word floating-table specification](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablepositionproperties), and [python-pptx text API](https://python-pptx.readthedocs.io/en/stable/user/text.html).
