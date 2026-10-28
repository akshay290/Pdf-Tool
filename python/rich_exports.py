"""Local PDF layout recovery and structured Markdown, using permissive engines."""
import io
import ctypes
import re
import statistics
import zipfile
from urllib.parse import quote, urlsplit

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader

class RichExportError(ValueError):
    pass


MAX_OUTPUT = 64 * 1024 * 1024
MAX_TEXT = 2_000_000
UNSAFE_XML = re.compile(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


def clean(value):
    return UNSAFE_XML.sub("", "" if value is None else str(value)).replace("\r", "")


def validate(raw, limit=100):
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > 16 * 1024 * 1024:
        raise RichExportError("Choose a readable PDF smaller than 16 MB.")
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        encrypted, count = reader.is_encrypted, len(reader.pages) if not reader.is_encrypted else 0
    except Exception:
        raise RichExportError("This PDF is damaged or cannot be opened for conversion.") from None
    if encrypted:
        raise RichExportError("This PDF is password-protected. Use Unlock PDF before converting it.")
    if not count or count > limit:
        raise RichExportError(f"This conversion supports 1 to {limit} pages. Split a longer PDF first.")
    return count


def rgb(value):
    try:
        values = [float(value)] if isinstance(value, (float, int)) else list(value or [0])
        if len(values) == 1:
            values *= 3
        elif len(values) == 4:
            c, m, y, k = values
            values = [1 - min(1, channel + k) for channel in [c, m, y]]
        return tuple(round(max(0, min(1, number)) * 255) for number in values[:3])
    except Exception:
        return (0, 0, 0)


def font_name(value):
    name = re.sub(r"^[A-Z]{6}\+", "", clean(value or "Arial"))
    lower = name.lower()
    if "helvetica" in lower or "arial" in lower:
        return "Arial"
    if "times" in lower:
        return "Times New Roman"
    if "courier" in lower:
        return "Courier New"
    return re.sub(r"[-,]?(BoldItalic|BoldOblique|Semibold|Bold|Italic|Oblique|Regular)$", "", name, flags=re.I) or "Arial"


def _safe_link(value):
    value = clean(value).strip()
    try:
        return value if urlsplit(value).scheme.lower() in ("https", "http", "mailto") else None
    except Exception:
        return None


def _inside(box, outer):
    x = (box[0] + box[2]) / 2
    y = (box[1] + box[3]) / 2
    return outer[0] - 1 <= x <= outer[2] + 1 and outer[1] - 1 <= y <= outer[3] + 1


def _line(chars, links):
    chars = sorted(chars, key=lambda item: item["x0"])
    spans, previous = [], None
    for char in chars:
        text = clean(char.get("text"))
        if not text:
            continue
        size = max(1, min(200, float(char.get("size", 11))))
        name = char.get("fontname", "Arial")
        url = next((link["url"] for link in links if _inside((char["x0"], char["top"], char["x1"], char["bottom"]), link["bbox"])), None)
        style = {"font": font_name(name), "size": size, "bold": any(word in name.lower() for word in ("bold", "black", "semibold")),
                 "italic": any(word in name.lower() for word in ("italic", "oblique")), "color": rgb(char.get("non_stroking_color")), "url": url}
        if previous and char["x0"] - previous["x1"] > max(1, size * .16) and not text.isspace() and not clean(previous.get("text")).isspace():
            if spans:
                spans[-1]["text"] += " "
        if spans and all(spans[-1][key] == value for key, value in style.items()):
            spans[-1]["text"] += text
        else:
            spans.append({"text": text, **style})
        previous = char
    return {"text": "".join(span["text"] for span in spans).strip(), "spans": spans,
            "bbox": (min(char["x0"] for char in chars), min(char["top"] for char in chars),
                     max(char["x1"] for char in chars), max(char["bottom"] for char in chars)),
            "size": statistics.median([float(char.get("size", 11)) for char in chars])}


def _table_rows(table):
    rows = [[clean(value).strip() for value in row] for row in table.extract()]
    rows = [row for row in rows if any(row)]
    if len(rows) < 2 or max((len(row) for row in rows), default=0) < 2:
        return None
    if sum(sum(bool(value) for value in row) >= 2 for row in rows) < 2:
        return None
    return {"bbox": table.bbox, "rows": rows, "cells": table.cells}


def tables_for(page):
    """Prefer ruled tables, then aligned text columns, without inventing cells."""
    ruled = [table for table in (_table_rows(item) for item in page.find_tables()) if table]
    if ruled:
        return ruled
    settings = {"vertical_strategy": "text", "horizontal_strategy": "text",
                "min_words_vertical": 2, "min_words_horizontal": 1,
                "text_x_tolerance": 2, "text_y_tolerance": 3,
                "intersection_x_tolerance": 5, "intersection_y_tolerance": 5}
    return [table for table in (_table_rows(item) for item in page.find_tables(settings)) if table]


def _pdfium_lines(document, page_index, links):
    """Recover character geometry when a PDF font has no usable PDFMiner widths."""
    page = document[page_index]
    textpage = page.get_textpage()
    groups, group = [], []
    height = page.get_height()
    try:
        for index in range(textpage.count_chars()):
            codepoint = pdfium.raw.FPDFText_GetUnicode(textpage.raw, index)
            text = chr(codepoint) if codepoint and codepoint <= 0x10ffff else ""
            if text in ("\r", "\n"):
                if group:
                    groups.append(group)
                    group = []
                continue
            if not text:
                continue
            left, bottom, right, top = textpage.get_charbox(index)
            size = max(1, pdfium.raw.FPDFText_GetFontSize(textpage.raw, index))
            if group and not text.isspace() and (left - group[-1]["x1"] > max(18, size * 2.5)
                                               or abs(height - top - group[-1]["top"]) > max(5, size * .75)):
                groups.append(group)
                group = []
            name_buffer, flags = ctypes.create_string_buffer(256), ctypes.c_int()
            pdfium.raw.FPDFText_GetFontInfo(textpage.raw, index, name_buffer, 256, ctypes.byref(flags))
            name = name_buffer.value.decode("utf8", errors="replace") or "Arial"
            if pdfium.raw.FPDFText_GetFontWeight(textpage.raw, index) >= 600 and "bold" not in name.lower():
                name += "-Bold"
            colors = [ctypes.c_uint() for _ in range(4)]
            pdfium.raw.FPDFText_GetFillColor(textpage.raw, index, *(ctypes.byref(color) for color in colors))
            group.append({"text": text, "x0": left, "x1": right, "top": height - top, "bottom": height - bottom,
                          "size": size, "fontname": name, "non_stroking_color": tuple(color.value / 255 for color in colors[:3])})
        if group:
            groups.append(group)
        return [_line(chars, links) for chars in groups if any(char["text"].strip() for char in chars)]
    finally:
        textpage.close()
        page.close()


def _aligned_tables(lines):
    rows = []
    for line in sorted(lines, key=lambda value: (value["bbox"][1], value["bbox"][0])):
        if rows and abs(line["bbox"][1] - rows[-1][0]["bbox"][1]) <= 4:
            rows[-1].append(line)
        else:
            rows.append([line])
    tables, group = [], []
    def flush():
        if len(group) < 2:
            return
        boxes = [cell["bbox"] for row in group for cell in row]
        tables.append({"rows": [[cell["text"] for cell in sorted(row, key=lambda value: value["bbox"][0])] for row in group],
                       "bbox": (min(box[0] for box in boxes), min(box[1] for box in boxes), max(box[2] for box in boxes), max(box[3] for box in boxes)),
                       "cells": boxes})
    for row in rows:
        row.sort(key=lambda value: value["bbox"][0])
        aligned = group and len(row) == len(group[-1]) and all(abs(a["bbox"][0] - b["bbox"][0]) <= 16 for a, b in zip(row, group[-1]))
        nearby = group and row[0]["bbox"][1] - group[-1][0]["bbox"][3] <= 60
        if len(row) >= 2 and (not group or (aligned and nearby)):
            group.append(row)
        else:
            flush()
            group = [row] if len(row) >= 2 else []
    flush()
    return tables


def extract_layout(raw, limit=100, include_images=False):
    validate(raw, limit)
    pages, total_text, image_total = [], 0, 0
    renderer = pdfium.PdfDocument(raw) if include_images else None
    if renderer is not None:
        renderer.init_forms()
    try:
        with pdfplumber.open(io.BytesIO(raw)) as document:
            for page_index, page in enumerate(document.pages):
                if len(page.chars) > 500_000 or total_text + len(page.chars) > MAX_TEXT:
                    raise RichExportError("This PDF contains too much text for one conversion. Split it first.")
                total_text += len(page.chars)
                links = []
                for link in page.hyperlinks:
                    url = _safe_link(link.get("uri"))
                    if url and all(key in link for key in ("x0", "top", "x1", "bottom")):
                        links.append({"url": url, "bbox": tuple(link[key] for key in ("x0", "top", "x1", "bottom"))})
                tables = tables_for(page)
                lines = []
                for source in page.extract_text_lines(return_chars=True):
                    groups, group = [], []
                    for char in sorted(source["chars"], key=lambda item: item["x0"]):
                        if group and char["x0"] - group[-1]["x1"] > max(18, float(char.get("size", 11)) * 2.5):
                            groups.append(group)
                            group = []
                        group.append(char)
                    if group:
                        groups.append(group)
                    for chars in groups:
                        line = _line(chars, links)
                        if line["text"]:
                            lines.append(line)
                usable = [char for char in page.chars if clean(char.get("text")).strip()]
                if usable and sum(char["x1"] - char["x0"] <= .01 for char in usable) > len(usable) * .3:
                    if renderer is None:
                        renderer = pdfium.PdfDocument(raw)
                        renderer.init_forms()
                    lines = _pdfium_lines(renderer, page_index, links)
                if not tables:
                    tables = _aligned_tables(lines)
                images = []
                image_page = renderer[page_index] if include_images and renderer else None
                try:
                    for source in page.images:
                        box = (max(0, source["x0"]), max(0, source["top"]), min(page.width, source["x1"]), min(page.height, source["bottom"]))
                        width, height = box[2] - box[0], box[3] - box[1]
                        if width <= 2 or height <= 2:
                            continue
                        item = {"bbox": box, "coverage": width * height / (page.width * page.height)}
                        if image_page:
                            if width * height * 4 > 12_000_000:
                                raise RichExportError("An embedded image is too large to export. Try fewer or smaller pages.")
                            bitmap = image_page.render(scale=2, crop=(box[0], page.height - box[3], page.width - box[2], box[1]))
                            try:
                                image = bitmap.to_pil().convert("RGB")
                                stream = io.BytesIO()
                                image.save(stream, format="PNG")
                                image.close()
                                item["bytes"] = stream.getvalue()
                                image_total += len(item["bytes"])
                                if image_total > MAX_OUTPUT:
                                    raise RichExportError("The exported images exceed 64 MB. Split the PDF first.")
                            finally:
                                bitmap.close()
                        images.append(item)
                finally:
                    if image_page is not None:
                        image_page.close()
                pages.append({"width": float(page.width), "height": float(page.height), "lines": lines,
                              "tables": tables, "images": images, "links": links})
                page.close()
        return pages
    except RichExportError:
        raise
    except Exception:
        raise RichExportError("The PDF layout could not be extracted. Try a readable PDF or run OCR first.") from None
    finally:
        if renderer:
            renderer.close()


def _md_text(text):
    return re.sub(r"([\\`*_\[\]<>|])", r"\\\1", clean(text))


def _md_span(span):
    text = _md_text(span["text"])
    # Spaces outside formatting delimiters keep Markdown valid across run changes.
    left, content, right = re.match(r"^(\s*)(.*?)(\s*)$", text, re.S).groups()
    if span.get("bold") and content:
        content = f"**{content}**"
    if span.get("italic") and content:
        content = f"*{content}*"
    if span.get("url") and content:
        target = quote(span["url"], safe=":/?&=%#@+~").replace("(", "%28").replace(")", "%29")
        content = f"[{content}]({target})"
    return left + content + right


def to_markdown(raw, include_images=False):
    pages = extract_layout(raw, limit=100, include_images=include_images)
    if not any(page["lines"] or page["tables"] or (include_images and page["images"]) for page in pages):
        raise RichExportError("This PDF has no extractable text or images. Run OCR first for scanned text.")
    sizes = [line["size"] for page in pages for line in page["lines"] if line["text"].strip()]
    baseline = statistics.median(sizes) if sizes else 11
    sections, assets = [], {}
    for page_index, page in enumerate(pages, start=1):
        blocks = []
        for table in page["tables"]:
            columns = max(len(row) for row in table["rows"])
            rows = [[_md_text(value).replace("\n", "<br>") for value in row] + [""] * (columns - len(row)) for row in table["rows"]]
            body = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * columns) + " |"]
            body.extend("| " + " | ".join(row) + " |" for row in rows[1:])
            blocks.append((table["bbox"][1], table["bbox"][0], "\n".join(body)))
        for line in page["lines"]:
            if any(_inside(line["bbox"], table["bbox"]) for table in page["tables"]):
                continue
            text = "".join(_md_span(span) for span in line["spans"]).strip()
            if line["size"] >= baseline * 1.35 and len(line["text"]) <= 180:
                level = 1 if line["size"] >= baseline * 1.9 else 2
                text = "#" * level + " " + text
            elif re.match(r"^[•●▪]\s*", line["text"]):
                text = "- " + re.sub(r"^[•●▪]\s*", "", text)
            blocks.append((line["bbox"][1], line["bbox"][0], text))
        if include_images:
            for image_index, image in enumerate(page["images"], start=1):
                name = f"images/page-{page_index}-image-{image_index}.png"
                assets[name] = image["bytes"]
                # Full-page scans are retained as reference images after the
                # recovered text; other embedded graphics follow page order.
                top = page["height"] + 1 if image["coverage"] > .7 else image["bbox"][1]
                blocks.append((top, image["bbox"][0], f"![Page {page_index} image {image_index}]({name})"))
        sections.append("\n\n".join(block[2] for block in sorted(blocks)))
    text = "\n\n---\n\n".join(sections).strip() + "\n"
    if not text.strip() and not assets:
        raise RichExportError("This PDF has no extractable text or images. Run OCR first for scanned text.")
    if include_images:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("document.md", text.encode("utf8"))
            for name, data in assets.items():
                archive.writestr(name, data)
        data, name, media = stream.getvalue(), "localfold-markdown.zip", "application/zip"
    else:
        data, name, media = text.encode("utf8"), "localfold-document.md", "text/markdown; charset=utf-8"
    if len(data) > MAX_OUTPUT:
        raise RichExportError("The Markdown export exceeds 64 MB. Split the PDF first.")
    return {"data": data, "pageCount": len(pages), "name": name, "mediaType": media, "text": text}
