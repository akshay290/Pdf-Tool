"""Local document operations. JSON enters stdin; document bytes stay in memory."""
import base64
import difflib
import io
import json
import logging
import re
import sys
import zipfile
from pathlib import PurePosixPath
import xml.etree.ElementTree as ET

from PIL import Image
import pypdf
from pypdf import PdfReader, PdfWriter
import pypdfium2 as pdfium
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

logging.getLogger("pypdf").setLevel(logging.ERROR)
MAX_INPUT = 16 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
MAX_RENDER_PIXELS = 12_000_000


class InputError(Exception):
    pass


def decode(file):
    if not isinstance(file, dict) or not isinstance(file.get("data"), str):
        raise InputError("Choose a PDF file to continue.")
    encoded = file["data"]
    if len(encoded) > MAX_INPUT * 4 // 3 + 8:
        raise InputError("Keep each PDF below 16 MB.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception:
        raise InputError("The PDF could not be read.")
    if not raw or len(raw) > MAX_INPUT:
        raise InputError("The PDF is empty or larger than 16 MB.")
    return raw


def reader_for(raw, password=None):
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            if not isinstance(password, str) or not password:
                raise InputError("This PDF needs its password. Use Unlock PDF first.")
            if not reader.decrypt(password):
                raise InputError("The supplied password does not open this PDF.")
        if not reader.pages:
            raise InputError("This PDF contains no pages.")
        return reader
    except InputError:
        raise
    except Exception:
        raise InputError("This PDF is damaged or cannot be opened by the local engine.")


def packed(raw, count, name, media="application/pdf", **extra):
    if len(raw) > MAX_OUTPUT:
        raise InputError("The generated output exceeds the 64 MB limit. Try fewer pages or a lower resolution.")
    return {"data": base64.b64encode(raw).decode("ascii"), "pageCount": count,
            "name": name, "mediaType": media, **extra}


def write_pdf(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def render_pages(raw, dpi=144, limit=40, quality=88, image_format="jpg", page_start=1, page_end=None):
    try:
        document = pdfium.PdfDocument(raw)
        document.init_forms()
    except Exception:
        raise InputError("This PDF is damaged or password-protected. Unlock it before rendering.")
    try:
        if len(document) > limit:
            raise InputError(f"This operation supports up to {limit} pages per task. Split the PDF first.")
        page_end = len(document) if page_end is None else page_end
        if type(page_start) is not int or type(page_end) is not int or page_start < 1 or page_end < page_start or page_end > len(document):
            raise InputError("Choose a valid page range to render.")
        result = []
        for index in range(page_start - 1, page_end):
            page = document[index]
            bitmap = None
            image = None
            try:
                width, height = page.get_size()
                scale = dpi / 72
                if width <= 0 or height <= 0 or width * height * scale * scale > MAX_RENDER_PIXELS:
                    raise InputError("A page is too large to render safely at this resolution. Choose a lower DPI.")
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil().convert("RGB")
                output = io.BytesIO()
                image.save(output, format="PNG" if image_format == "png" else "JPEG", quality=quality, optimize=True)
                result.append({"bytes": output.getvalue(), "width": width, "height": height, "page": index+1})
                if sum(len(item["bytes"]) for item in result) > MAX_OUTPUT:
                    raise InputError("The rendered pages exceed 64 MB. Try fewer pages or a lower resolution.")
            finally:
                if image is not None:
                    image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
        return result
    finally:
        document.close()


def _compress_lossless(reader):
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    for page in writer.pages:
        page.compress_content_streams(level=9)
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    return write_pdf(writer)


def _compress_target(raw, reader, target):
    """A maximum-size search, with content-preserving candidates preferred.

    Image JPEG candidates preserve page content/forms. Raster candidates render
    one page at a time and never go below 72 DPI/JPEG quality 35. Long documents
    share the same 70-second/24-trial budget instead of an arbitrary page cap.
    """
    import math
    import time

    if type(target) is not int or not 1000 <= target <= MAX_INPUT:
        raise InputError("Choose a target maximum between 1000 and 16777216 bytes, as a whole number.")
    deadline = time.monotonic() + 70
    best = {"bytes": raw, "method": "original", "dpi": None, "jpeg": None, "imageScale": None}
    attempts = 0

    def package(candidate, reason=""):
        reached = len(candidate["bytes"]) <= target
        method = candidate["method"]
        if reached:
            messages = {
                "original": "This PDF is already at or below the target maximum. The original document was preserved.",
                "lossless": "The target maximum was reached with lossless optimization. Text, vector graphics, and forms were preserved.",
                "image-jpeg": "The target maximum was reached by recompressing embedded images. Selectable text and forms were preserved; image quality was reduced.",
                "raster-jpeg": "The target maximum was reached by rasterizing pages. Selectable text and interactive form fields were removed.",
            }
            message = messages[method]
            if method == "image-jpeg" and candidate.get("imageScale", 1) < 1:
                message = "The target maximum was reached by reducing embedded image resolution and JPEG quality. Selectable text, vector graphics, page placement, and forms were preserved."
        else:
            message = "The target maximum could not be reached. The smallest tested valid PDF was returned without exceeding the original size. "
            if method == "raster-jpeg":
                message += "This result rasterizes pages and removes selectable text and interactive form fields. "
            elif method == "image-jpeg":
                message += "Embedded image resolution and JPEG quality were reduced while retaining text and forms. " if candidate.get("imageScale", 1) < 1 else "Embedded image quality was reduced while retaining text and forms. "
            message += reason or "The local quality floor is 72 DPI and JPEG quality 35; use a larger maximum or split the document."
        return packed(candidate["bytes"], len(reader.pages), "localfold-compressed.pdf", inputBytes=len(raw),
                      outputBytes=len(candidate["bytes"]), reduced=len(candidate["bytes"]) < len(raw),
                      rasterized=method == "raster-jpeg", targetBytes=target, targetReached=reached,
                      qualityDpi=candidate["dpi"], qualityJpeg=candidate["jpeg"], attempts=attempts,
                      imageScale=candidate.get("imageScale"), compressionMethod=method, resultMessage=message)

    def consider(data, method, dpi=None, quality=None, image_scale=None):
        nonlocal best, attempts
        attempts += 1
        candidate = {"bytes": data, "method": method, "dpi": dpi, "jpeg": quality, "imageScale": image_scale}
        if len(data) < len(best["bytes"]):
            best = candidate
        return candidate

    def available():
        return time.monotonic() < deadline and attempts < 24

    if len(raw) <= target:
        return package(best)
    try:
        optimized = consider(_compress_lossless(reader), "lossless")
        if len(optimized["bytes"]) <= target:
            return package(optimized)
    except Exception:
        # A failure to optimize must not discard a readable original PDF.
        pass
    if not available():
        return package(best, "The bounded local search finished. Try a larger maximum or split the document.")

    # Inspect XObject headers before decoding images. Masks, inline images,
    # unusual color spaces and large images are deliberately left unchanged.
    selected, seen, pixels, visited = [], set(), 0, 0

    def inspect_images(node, page_index, prefix=(), depth=0):
        nonlocal pixels, visited
        if depth > 6 or not available():
            return
        resources = node.get("/Resources")
        if resources is None:
            return
        resources = resources.get_object()
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return
        for name, reference in xobjects.get_object().items():
            visited += 1
            if visited > 5000 or len(selected) >= 32:
                return
            obj = reference.get_object()
            identity = (getattr(reference, "idnum", None), getattr(reference, "generation", None)) if hasattr(reference, "idnum") else id(obj)
            if identity in seen:
                continue
            seen.add(identity)
            path = (*prefix, str(name))
            if obj.get("/Subtype") == "/Form":
                inspect_images(obj, page_index, path, depth + 1)
            elif obj.get("/Subtype") == "/Image":
                width, height = obj.get("/Width", 0), obj.get("/Height", 0)
                if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
                    continue
                count = int(width) * int(height)
                if min(width, height) <= 0 or max(width, height) > 20000 or count > MAX_RENDER_PIXELS or pixels + count > 24_000_000:
                    continue
                if obj.get("/SMask") is not None or obj.get("/Mask") is not None or obj.get("/ImageMask") or obj.get("/Decode") is not None:
                    continue
                if str(obj.get("/ColorSpace")) not in ("/DeviceRGB", "/DeviceGray") or obj.get("/BitsPerComponent", 8) != 8:
                    continue
                filters = obj.get("/Filter")
                filters = [str(value) for value in filters] if isinstance(filters, (list, tuple)) else [str(filters)]
                # ReportLab and other common producers wrap JPEG/Flate data in
                # ASCII85 or ASCIIHex. These lossless transport filters do not
                # change the image's color/mask eligibility or pixel budget.
                if len(filters) == 2 and filters[0] in ("/ASCII85Decode", "/ASCIIHexDecode"):
                    filters = filters[1:]
                if len(filters) != 1 or filters[0] not in ("/FlateDecode", "/DCTDecode"):
                    continue
                pixels += count
                selected.append((page_index, path))

    source_images = []
    try:
        for page_index, page in enumerate(reader.pages):
            inspect_images(page, page_index)
        for page_index, path in selected:
            if not available():
                break
            try:
                image_file = reader.pages[page_index].images[list(path)]
                image = image_file.image
                copy = image.copy() if image.mode in ("RGB", "L") else image.convert("RGB")
                image.close()
                source_images.append((page_index, path, copy))
            except Exception:
                continue

        def image_size(source, scale):
            effective_scale = max(scale, min(1, 64 / min(source.size)))
            return tuple(max(1, round(value * effective_scale)) for value in source.size)

        def image_candidate(quality, scale=1):
            writer = PdfWriter()
            writer.clone_document_from_reader(reader)
            used_scale = 1
            for page_index, path, source in source_images:
                if not available():
                    return None
                image_file = writer.pages[page_index].images[list(path)]
                old = image_file.image
                resized = None
                try:
                    # Reduce only the image's pixels: its PDF placement matrix,
                    # surrounding vector text and form fields stay untouched.
                    # The shortest edge stops at 64px, with no upsampling of
                    # already-small images and only one resized bitmap alive.
                    size = image_size(source, scale)
                    if size != source.size:
                        resized = source.resize(size, Image.Resampling.LANCZOS)
                        used_scale = min(used_scale, *(value / original for value, original in zip(size, source.size)))
                    image_file.replace(resized or source, quality=quality, optimize=True)
                finally:
                    if resized is not None:
                        resized.close()
                    old.close()
                    if image_file.image is not old:
                        image_file.image.close()
            writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
            return consider(write_pdf(writer), "image-jpeg", quality=quality, image_scale=used_scale)

        def search_quality(make):
            """Find the highest tested JPEG quality fitting this resolution."""
            if not available():
                return None
            high = make(95)
            if high is not None and len(high["bytes"]) <= target:
                return high
            if not available():
                return None
            low = make(35)
            if low is None or len(low["bytes"]) > target:
                return None
            chosen, left, right = low, 36, 94
            for _ in range(6):
                if left > right or not available():
                    break
                quality = (left + right) // 2
                trial = make(quality)
                if trial is None:
                    break
                if len(trial["bytes"]) <= target:
                    chosen, left = trial, quality + 1
                else:
                    right = quality - 1
            return chosen

        if source_images and available():
            try:
                # Prefer the largest image resolution that can meet the target
                # before considering destructive whole-page rasterization.
                tested_sizes = set()
                for scale in (1, .85, .7, .55, .4, .3, .2):
                    if not available():
                        break
                    sizes = tuple(image_size(source, scale) for _, _, source in source_images)
                    if sizes in tested_sizes:
                        continue
                    tested_sizes.add(sizes)
                    preserved = search_quality(lambda quality: image_candidate(quality, scale))
                    if preserved is not None:
                        return package(preserved)
            except Exception:
                # The raster fallback may handle a PDF with exotic image data.
                pass
    finally:
        for _, _, image in source_images:
            image.close()

    if not available():
        return package(best, "The bounded local search finished. Try a larger maximum or split the document.")

    try:
        with pdfium.PdfDocument(raw) as document:
            document.init_forms()
            sizes = []
            for index in range(len(document)):
                page = document[index]
                try:
                    sizes.append(page.get_size())
                finally:
                    page.close()
            possible = []
            for dpi in (144, 120, 96, 72):
                counts = [math.ceil(width * dpi / 72) * math.ceil(height * dpi / 72) for width, height in sizes]
                # Rendering is page-at-a-time: the per-page cap bounds bitmap
                # memory, while this separate whole-task cap bounds CPU work.
                if all(min(size) > 0 for size in sizes) and max(counts) <= MAX_RENDER_PIXELS and sum(counts) <= 120_000_000:
                    possible.append(dpi)
            if not possible:
                return package(best, "The pages exceed the bounded local raster budget at the 72 DPI quality floor. Split the PDF or use a larger maximum.")

            for dpi in possible:
                if not available():
                    break
                def raster_candidate(quality):
                    output = io.BytesIO()
                    pdf = canvas.Canvas(output, pageCompression=1)
                    encoded_bytes = 0
                    for index, (width, height) in enumerate(sizes):
                        if not available():
                            return None
                        page = document[index]
                        bitmap = image = None
                        try:
                            bitmap = page.render(scale=dpi / 72)
                            image = bitmap.to_pil().convert("RGB")
                            encoded = io.BytesIO()
                            image.save(encoded, format="JPEG", quality=quality, optimize=True)
                            # ReportLab retains encoded image streams until
                            # save. Bound those too, not only the live bitmap.
                            encoded_bytes += encoded.tell()
                            if encoded_bytes > MAX_OUTPUT:
                                return None
                            pdf.setPageSize((width, height))
                            pdf.drawImage(ImageReader(io.BytesIO(encoded.getvalue())), 0, 0, width=width, height=height)
                            pdf.showPage()
                        finally:
                            if image is not None:
                                image.close()
                            if bitmap is not None:
                                bitmap.close()
                            page.close()
                    pdf.save()
                    return consider(output.getvalue(), "raster-jpeg", dpi=dpi, quality=quality)

                reached = search_quality(raster_candidate)
                if reached is not None:
                    return package(reached)
    except Exception:
        # The validated original/best candidate remains a usable honest result.
        return package(best, "Some page content could not be rasterized within the local limits. Try a larger maximum or split the PDF.")
    if not available():
        return package(best, "The bounded local search ended before every quality setting could be tested. Try a larger maximum or split the PDF.")
    return package(best)


def compress(payload):
    raw = decode(payload.get("file"))
    mode = payload.get("compression", "lossless")
    reader = reader_for(raw)
    if mode == "target":
        return _compress_target(raw, reader, payload.get("targetBytes"))
    if mode == "lossless":
        generated = _compress_lossless(reader)
    elif mode in ("balanced", "small"):
        pages = render_pages(raw, dpi=144 if mode == "balanced" else 96, quality=78 if mode == "balanced" else 58)
        output = io.BytesIO()
        pdf = canvas.Canvas(output, pageCompression=1)
        for page in pages:
            pdf.setPageSize((page["width"], page["height"]))
            pdf.drawImage(ImageReader(io.BytesIO(page["bytes"])), 0, 0, width=page["width"], height=page["height"])
            pdf.showPage()
        pdf.save()
        generated = output.getvalue()
    else:
        raise InputError("Choose lossless, balanced, small, or target compression.")
    smaller = len(generated) < len(raw)
    result = generated if smaller else raw
    return packed(result, len(reader.pages), "localfold-compressed.pdf", inputBytes=len(raw), outputBytes=len(result),
                  reduced=smaller, rasterized=mode != "lossless" and smaller)


def protect(payload):
    raw = decode(payload.get("file"))
    password = payload.get("password")
    if not isinstance(password, str) or len(password) < 8 or len(password.encode("utf8")) > 256:
        raise InputError("Choose a password with at least 8 characters and at most 256 UTF-8 bytes.")
    reader = reader_for(raw)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    writer.encrypt(user_password=password, owner_password=password, algorithm="AES-256")
    return packed(write_pdf(writer), len(reader.pages), "localfold-protected.pdf")


def unlock(payload):
    raw = decode(payload.get("file"))
    password = payload.get("password")
    if not isinstance(password, str) or len(password.encode("utf8")) > 256:
        raise InputError("Supply the existing PDF password, up to 256 UTF-8 bytes.")
    reader = reader_for(raw, password)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    return packed(write_pdf(writer), len(reader.pages), "localfold-unlocked.pdf")


def repair(payload):
    raw = decode(payload.get("file"))
    reader = reader_for(raw)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    generated = write_pdf(writer)
    # Independently reopen the rebuilt result before presenting it as an output.
    validation = reader_for(generated)
    return packed(generated, len(validation.pages), "localfold-rebuilt.pdf")


def extract(raw, limit=200):
    try:
        document = pdfium.PdfDocument(raw)
    except Exception:
        raise InputError("The PDF could not be opened. Unlock password-protected files first.")
    try:
        if len(document) > limit:
            raise InputError(f"Text extraction supports up to {limit} pages per task.")
        text = []
        for index in range(len(document)):
            page = document[index]
            textpage = page.get_textpage()
            try:
                text.append(textpage.get_text_range().replace("\r\n", "\n"))
                if sum(map(len, text)) > 2_000_000:
                    raise InputError("The extracted text is too large. Split this PDF first.")
            finally:
                textpage.close()
                page.close()
        return text
    finally:
        document.close()


def text_output(payload):
    if payload.get("format", "txt") == "md":
        from rich_exports import to_markdown, RichExportError
        try:
            result = to_markdown(decode(payload.get("file")), include_images=bool(payload.get("includeImages", False)))
            return packed(result["data"], result["pageCount"], result["name"], result["mediaType"], text=result.get("text", ""))
        except RichExportError as error:
            raise InputError(str(error)) from None
    pages = extract(decode(payload.get("file")))
    fmt = payload.get("format", "txt")
    if fmt not in ("txt", "md"):
        raise InputError("Choose TXT or Markdown output.")
    text = "\n\n".join(f"## Page {index + 1}\n\n{text}" if fmt == "md" else text for index, text in enumerate(pages))
    return packed(text.encode("utf8"), len(pages), f"localfold-text.{fmt}",
                  "text/markdown; charset=utf-8" if fmt == "md" else "text/plain; charset=utf-8", text=text)


def compare(payload):
    files = payload.get("files")
    if not isinstance(files, list) or len(files) != 2:
        raise InputError("Choose exactly two PDFs to compare their text.")
    before = extract(decode(files[0]))
    after = extract(decode(files[1]))
    first = "\n\n".join(before)
    second = "\n\n".join(after)
    if max(len(first), len(second)) > 200_000:
        raise InputError("Text comparison supports up to 200,000 characters per PDF. Split larger documents first.")
    diff = list(difflib.unified_diff(first.splitlines(), second.splitlines(), fromfile="first.pdf", tofile="second.pdf", lineterm=""))
    header = f"# PDF text comparison\n\nFirst PDF: {len(before)} pages. Second PDF: {len(after)} pages.\n\n"
    header += "This compares extracted text only. Images, page layout, and handwritten changes are not compared.\n\n"
    report = header + ("No differences were found in the extracted text.\n" if not diff else "```diff\n" + "\n".join(diff) + "\n```\n")
    return packed(report.encode("utf8"), len(after), "localfold-comparison.md", "text/markdown; charset=utf-8", text=report)


def render(payload):
    raw = decode(payload.get("file"))
    fmt = payload.get("format", "jpg")
    dpi = payload.get("dpi", 144)
    if fmt not in ("jpg", "png") or dpi not in (72, 96, 144, 200):
        raise InputError("Choose JPG or PNG and a supported resolution (72, 96, 144, or 200 DPI).")
    pages = render_pages(raw, dpi=dpi, image_format=fmt)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for index, page in enumerate(pages):
            archive.writestr(f"page-{index + 1:04d}.{fmt}", page["bytes"])
    return packed(output.getvalue(), len(pages), "localfold-pages.zip", "application/zip")


def office_check(payload):
    file = payload.get("file")
    raw = decode(file)
    extension = str(file.get("name", "")).lower().rsplit(".", 1)[-1]
    if extension in ("doc", "xls", "ppt"):
        import olefile
        if not olefile.isOleFile(io.BytesIO(raw)):
            raise InputError("This legacy Office file is not a valid DOC, XLS, or PPT container.")
        try:
            with olefile.OleFileIO(io.BytesIO(raw)) as container:
                names = container.listdir()
                if len(names) > 5000 or sum(container.get_size(name) for name in names) > 100 * 1024 * 1024:
                    raise InputError("This Office document expands beyond the local processing limit.")
                lowered = ["/".join(name).lower() for name in names]
                if any(any(token in name for token in ("vba", "macros", "objectpool", "encryptedpackage", "encryptioninfo", "encryptionsummary")) for name in lowered):
                    raise InputError("Remove macros, embedded objects, or encryption from this legacy Office file before converting.")
                expected = {"doc": ["worddocument"], "xls": ["workbook", "book"], "ppt": ["powerpoint document"]}[extension]
                main = next((name for name in names if "/".join(name).lower() in expected), None)
                if main is None:
                    raise InputError("The document content does not match its legacy Office extension.")
                content = container.openstream(main).read()
                if extension == "doc" and len(content) > 12 and int.from_bytes(content[10:12], "little") & 0x8100:
                    raise InputError("Remove encryption from this Word file before converting.")
                if extension == "xls":
                    cursor = 0
                    while cursor + 4 <= len(content):
                        kind = int.from_bytes(content[cursor:cursor+2], "little")
                        size = int.from_bytes(content[cursor+2:cursor+4], "little")
                        if kind == 0x002f:
                            raise InputError("Remove encryption from this Excel file before converting.")
                        if kind == 0x01ae and content[cursor+6:cursor+8] not in (b"\x01\x04", b"\x01\x3a"):
                            raise InputError("Remove linked workbooks or external connections before converting.")
                        cursor += 4 + size
                return {"extension": extension}
        except InputError:
            raise
        except Exception:
            raise InputError("This legacy Office file is damaged or unsupported.") from None
    roots = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}
    if extension not in roots:
        raise InputError("Choose a DOCX, XLSX, or PPTX file. Macro-enabled and legacy Office formats are not supported.")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            names = {entry.filename for entry in entries}
            if len(entries) > 5000 or sum(entry.file_size for entry in entries) > 100 * 1024 * 1024:
                raise InputError("This Office document is too complex or expands beyond 100 MB.")
            if roots[extension] not in names or "[Content_Types].xml" not in names:
                raise InputError("The document content does not match its Office file extension.")
            for entry in entries:
                name = entry.filename.lower()
                parts = PurePosixPath(name).parts
                if entry.flag_bits & 1 or name.startswith("/") or ".." in parts or "\\" in name:
                    raise InputError("Encrypted or unsafe Office containers are not supported.")
                if "vbaproject" in name or "/embeddings/" in name or "externallink" in name or name.endswith("connections.xml"):
                    raise InputError("Remove macros, embedded objects, data connections, and external links before converting.")
                if not (name.endswith(".xml") or name.endswith(".rels")):
                    continue
                if entry.file_size > 20 * 1024 * 1024:
                    raise InputError("An Office document component exceeds the 20 MB limit.")
                xml = archive.read(entry)
                if re.search(br"<!\s*(DOCTYPE|ENTITY)", xml, re.I):
                    raise InputError("Office XML declarations with external entities are not supported.")
                tree = ET.fromstring(xml)
                for element in tree.iter():
                    local = element.tag.rsplit("}", 1)[-1]
                    if local == "Relationship" and element.get("TargetMode", "").lower() == "external":
                        safe_hyperlink = element.get("Type") == "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" and re.fullmatch(r"(?:https?://|mailto:)[^\s\x00-\x1f]+", element.get("Target", ""), re.I)
                        if not safe_hyperlink:
                            raise InputError("Remove external linked media, templates and data before converting this document.")
                    instruction = element.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}instr", "")
                    if local == "instrText":
                        instruction += element.text or ""
                    if re.search(r"\b(INCLUDETEXT|INCLUDEPICTURE|DDEAUTO|DDE|LINK)\b", instruction, re.I):
                        raise InputError("Linked content and DDE fields are not supported. Remove them before converting.")
                    if local == "f" and re.search(r"\b(WEBSERVICE|FILTERXML|HYPERLINK|RTD|IMAGE|STOCKHISTORY|CUBE\w*)\s*\(|\[|https?:|file:", element.text or "", re.I):
                        raise InputError("Remove spreadsheet formulas that fetch external content before converting.")
            return {"extension": extension}
    except InputError:
        raise
    except Exception:
        raise InputError("This Office file is damaged or is not a supported Open XML document.") from None


def run(operation, payload):
    if operation == "resize-image":
        from image_resize import resize_image, ImageResizeError
        try:
            return resize_image(payload)
        except ImageResizeError as error:
            raise InputError(str(error)) from None
    if operation == "compress-image":
        from image_compression import compress_image, ImageCompressionError
        try:
            return compress_image(payload)
        except ImageCompressionError as error:
            raise InputError(str(error)) from None
    operations = {"compress": compress, "protect": protect, "unlock": unlock, "repair": repair,
                  "text": text_output, "compare": compare, "render": render}
    if operation in operations:
        return operations[operation](payload)
    if operation == "office-check":
        return office_check(payload)
    if operation in ("docx", "pptx", "xlsx"):
        from office_exports import to_docx, to_pptx, to_xlsx, _ExportError
        converters = {"docx": to_docx, "pptx": to_pptx, "xlsx": to_xlsx}
        media = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                 "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
        try:
            output, count = converters[operation](decode(payload.get("file")))
        except _ExportError as error:
            raise InputError(str(error)) from None
        return packed(output, count, f"localfold-export.{operation}", media[operation])
    if operation == "ocr-raster":
        raw = decode(payload.get("file"))
        count = len(reader_for(raw).pages)
        pages = render_pages(raw, dpi=144, limit=50, quality=94, page_start=payload.get("pageStart", 1), page_end=payload.get("pageEnd"))
        return {"pages": [{"data": base64.b64encode(page["bytes"]).decode("ascii"),
                           "width": page["width"], "height": page["height"], "page": page["page"]} for page in pages], "pageCount": count}
    if operation in ("preview", "extract-images", "compare-visual"):
        from inspection_ops import preview, extract_images, visual_compare, InspectionError
        try:
            if operation == "preview":
                return preview(decode(payload.get("file")), payload)
            if operation == "extract-images":
                output, count = extract_images(decode(payload.get("file")))
                return packed(output, count, "localfold-embedded-images.zip", "application/zip")
            files = payload.get("files")
            if not isinstance(files, list) or len(files) != 2:
                raise InputError("Choose exactly two PDFs for visual comparison.")
            output, count = visual_compare(decode(files[0]), decode(files[1]))
            return packed(output, count, "localfold-visual-comparison.zip", "application/zip")
        except InspectionError as error:
            raise InputError(str(error)) from None
    if operation in ("studio-text-objects", "studio-replace-text"):
        from studio_engine import inspect_text, replace_text, StudioInputError
        try:
            raw = decode(payload.get("file"))
            if operation == "studio-text-objects":
                return {"objects": inspect_text(raw, payload.get("page", 1))}
            output, count = replace_text(raw, payload)
            return packed(output, count, "localfold-edited.pdf")
        except StudioInputError as error:
            raise InputError(str(error)) from None
    if operation == "capabilities":
        return {"pdf": True, "render": True, "crypto": True, "pypdf": pypdf.__version__}
    raise InputError("This local operation is unavailable.")


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        response = {"ok": True, **run(request.get("operation"), request.get("payload") or {})}
    except InputError as error:
        response = {"ok": False, "error": str(error)}
    except Exception:
        # Never echo passwords, file content, or external-library stack traces.
        response = {"ok": False, "error": "The local engine could not process this document. Try another file or a simpler operation."}
    sys.stdout.write(json.dumps(response, ensure_ascii=True))
