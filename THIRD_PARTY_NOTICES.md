# Third-party notices

Copies of 64 installed JavaScript and Python dependency notice files are preserved in `licenses/javascript/` and `licenses/python/`. The original notices also remain with the installed packages. See `DEPENDENCIES.md` for versions, sources, and the separate LibreOffice runtime license and source information.

The six OCR model files retain the Apache-2.0 license in `runtime/tessdata/LICENSE`. Setup pins the official tessdata_fast revision `87416418657359cb625c412a48b6e1d6d41c29bd` and checks each model against `python/ocr-models.json`. Installed system fonts used for text substitution are not redistributed by this project.

The image compressor additionally uses pillow-heif 1.8.1. Its BSD-3-Clause source license and separate GPLv2 wheel/component notices are preserved in `licenses/python/pillow_heif-1.8.1.dist-info/licenses/`, including corresponding source links. See `DEPENDENCIES.md` for its HEIC/HEIF scope. Setup installs its runtime binaries; they are not committed.

## pdf-lib 1.17.1

This project uses [pdf-lib](https://github.com/Hopding/pdf-lib), Copyright (c) 2019 Andrew Dillon, under the MIT License.

```text
MIT License

Copyright (c) 2019 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

The lockfile pins the dependency tree. These upstream packages and their license files are present under `node_modules` after `npm install`:

| Package | Version | License | Notice |
|---|---:|---|---|
| `@pdf-lib/standard-fonts` | 1.0.0 | MIT | Copyright (c) 2018 Andrew Dillon |
| `@pdf-lib/upng` | 1.0.1 | MIT | Copyright (c) 2017 Photopea |
| `pako` | 1.0.11 | MIT AND Zlib | Copyright (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn |
| `tslib` | 1.14.1 | 0BSD | Copyright (c) Microsoft Corporation |

Their original license texts remain in the installed package folders and must accompany any redistribution that includes those packages. LocalFold source is separately licensed under the MIT license in `LICENSE`.
