"""Original PDF text-object inspection/replacement using permissive PDFium/pypdf.

Coordinates use the unrotated CropBox's top-left corner. Only direct horizontal,
single-line, fill-mode text objects without clipping are editable. Standard Latin
fonts retain their font; other fonts substitute an installed Arial/DejaVu TTF.
Complex shaping, nested Form XObjects and scanned-image text are not supported.
"""
import ctypes
import io
import math
from pathlib import Path
import re
import unicodedata

import pypdfium2 as pdfium
import pypdfium2.raw as raw_api
from pypdf import PdfReader, PdfWriter


class StudioInputError(Exception):
    pass


STANDARD = {"Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
            "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
            "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"}


def _source(raw):
    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            raise StudioInputError("Unlock this PDF with its password before editing text.")
        if not 1 <= len(reader.pages) <= 200:
            raise StudioInputError("Text-object editing supports between 1 and 200 pages.")
        return reader
    except StudioInputError:
        raise
    except Exception:
        raise StudioInputError("This PDF could not be opened for text editing.") from None


def _page_index(page, count):
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= count:
        raise StudioInputError(f"Choose a page between 1 and {count}.")
    return page - 1


def _box(reader, index):
    page = reader.pages[index]
    crop, media = page.cropbox, page.mediabox
    box = (max(float(crop.left), float(media.left)), max(float(crop.bottom), float(media.bottom)),
           min(float(crop.right), float(media.right)), min(float(crop.top), float(media.top)))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise StudioInputError("This page has no visible area inside its media bounds.")
    return box


def _describe(obj, index, crop):
    left, bottom, right, top = obj.get_bounds()
    matrix = obj.get_matrix()
    text = obj.extract()
    font = obj.get_font()
    font_name = font.get_base_name()
    size = obj.get_font_size()
    reason = ""
    if not text.strip() or "\n" in text or "\r" in text:
        reason = "Only single-line text objects can be edited."
    elif any(not math.isfinite(value) for value in matrix.get()) or abs(matrix.b) > 0.0001 or abs(matrix.c) > 0.0001 or matrix.a <= 0 or matrix.d <= 0:
        reason = "Rotated, skewed, or reflected text objects are not supported."
    elif raw_api.FPDFTextObj_GetTextRenderMode(obj) != raw_api.FPDF_TEXTRENDERMODE_FILL:
        reason = "Outlined, invisible, or clipping text objects are not supported."
    else:
        clip = raw_api.FPDFPageObj_GetClipPath(obj)
        if clip and raw_api.FPDFClipPath_CountPaths(clip) > 0:
            reason = "Text with an object clipping path is not supported."
    return {"objectIndex": index, "text": text, "x": left - crop[0], "y": crop[3] - top,
            "width": right - left, "height": top - bottom, "fontSize": size * abs(matrix.d),
            "fontName": font_name, "editable": not reason, "reason": reason,
            "fontSubstitution": font.is_embedded or font_name not in STANDARD}


def inspect_text(raw, page=1):
    reader = _source(raw)
    index = _page_index(page, len(reader.pages))
    document = pdfium.PdfDocument(raw)
    target = document[index]
    textpage = target.get_textpage()
    try:
        objects = []
        for object_index, obj in enumerate(target.get_objects(max_depth=1, textpage=textpage)):
            if obj.type != raw_api.FPDF_PAGEOBJ_TEXT:
                continue
            try:
                objects.append(_describe(obj, object_index, _box(reader, index)))
            except Exception:
                # An unreadable object is not exposed as an editable target.
                continue
        if len(objects) > 2000:
            raise StudioInputError("This page contains more than 2000 text objects. Split or simplify it first.")
        return objects
    finally:
        textpage.close()
        target.close()
        document.close()


def _latin_text(value):
    if not isinstance(value, str) or len(value) > 2000:
        raise StudioInputError("Replacement text must contain at most 2000 characters.")
    value = unicodedata.normalize("NFC", value)
    for char in value:
        point = ord(char)
        if point < 32 or 0x7f <= point <= 0x9f or unicodedata.category(char) in ("Cf", "Mn", "Mc") or not (point <= 0x24f or 0x2000 <= point <= 0x206f or point in (0x20ac, 0x2122)):
            raise StudioInputError("Existing-text replacement currently supports single-line Latin text and common punctuation. Complex script shaping is not supported.")
    return value


def _font_path(name):
    bold = "bold" in name.lower()
    italic = bool(re.search("italic|oblique", name, re.I))
    windows_name = "arialbi.ttf" if bold and italic else "arialbd.ttf" if bold else "ariali.ttf" if italic else "arial.ttf"
    linux_name = "DejaVuSans-BoldOblique.ttf" if bold and italic else "DejaVuSans-Bold.ttf" if bold else "DejaVuSans-Oblique.ttf" if italic else "DejaVuSans.ttf"
    for candidate in [Path("C:/Windows/Fonts") / windows_name,
                      Path("/usr/share/fonts/truetype/dejavu") / linux_name,
                      Path("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf")]:
        if candidate.is_file():
            return candidate
    raise StudioInputError("Font substitution needs an installed Arial or DejaVu Sans TrueType font.")


def _color(obj):
    values = [ctypes.c_uint() for _ in range(4)]
    if not raw_api.FPDFPageObj_GetFillColor(obj, *values):
        return (0, 0, 0, 255)
    return tuple(value.value for value in values)


def _set_text(obj, text):
    encoded = text.encode("utf-16-le") + b"\x00\x00"
    buffer = (raw_api.FPDF_WCHAR * (len(encoded) // 2)).from_buffer_copy(encoded)
    if not raw_api.FPDFText_SetText(obj, buffer):
        raise StudioInputError("PDFium could not encode the replacement text in this font.")


def replace_text(raw, payload):
    reader = _source(raw)
    items = payload.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 200:
        raise StudioInputError("Choose between 1 and 200 text objects to replace.")
    groups, seen = {}, set()
    for item in items:
        if not isinstance(item, dict):
            raise StudioInputError("Every text edit must identify a page and text object.")
        page_index = _page_index(item.get("page", 1), len(reader.pages))
        object_index = item.get("objectIndex")
        if isinstance(object_index, bool) or not isinstance(object_index, int) or object_index < 0:
            raise StudioInputError("Choose an existing text object from the page preview.")
        key = (page_index, object_index)
        if key in seen:
            raise StudioInputError("Each text object can be replaced only once per task.")
        seen.add(key)
        groups.setdefault(page_index, []).append((object_index, item, _latin_text(item.get("text"))))
    document = pdfium.PdfDocument(raw)
    loaded_fonts = {}
    try:
        for page_index, edits in groups.items():
            page = document[page_index]
            textpage = page.get_textpage()
            try:
                objects = list(page.get_objects(max_depth=1, textpage=textpage))
                details = {}
                for object_index, item, text in edits:
                    if object_index >= len(objects) or objects[object_index].type != raw_api.FPDF_PAGEOBJ_TEXT:
                        raise StudioInputError("The selected object is not a direct text object. Refresh the page preview.")
                    details[object_index] = _describe(objects[object_index], object_index, _box(reader, page_index))
                    if not details[object_index]["editable"]:
                        raise StudioInputError(details[object_index]["reason"])
            finally:
                textpage.close()  # Text-page handles must close before object removal.
            try:
                # Descending indices preserve object ordering while objects are removed.
                for object_index, item, text in sorted(edits, key=lambda entry: entry[0], reverse=True):
                    original = objects[object_index]
                    detail = details[object_index]
                    if not text:
                        page.remove_obj(original)
                        original.close()
                        continue
                    matrix = original.get_matrix()
                    size = item.get("fontSize", detail["fontSize"])
                    if isinstance(size, bool) or not isinstance(size, (int, float)) or not math.isfinite(size) or not 4 <= size <= 144:
                        raise StudioInputError("Replacement text size must be between 4 and 144 PDF points.")
                    color = _color(original)
                    if "color" in item:
                        if not isinstance(item["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", item["color"]):
                            raise StudioInputError("Choose a replacement color in #RRGGBB format.")
                        color = tuple(int(item["color"][offset:offset + 2], 16) for offset in (1, 3, 5)) + (color[3],)
                    opacity = item.get("opacity", color[3] / 255)
                    if isinstance(opacity, bool) or not isinstance(opacity, (int, float)) or not 0 <= opacity <= 1:
                        raise StudioInputError("Replacement text opacity must be between 0 and 1.")
                    # Existing standard fonts keep their font. Embedded/subset fonts
                    # use a full installed TTF, so new Latin glyphs are available.
                    replacement = original
                    if detail["fontSubstitution"] or any(ord(char) > 126 for char in text):
                        font_path = _font_path(detail["fontName"])
                        if str(font_path) not in loaded_fonts:
                            font_bytes = font_path.read_bytes()
                            buffer = (ctypes.c_ubyte * len(font_bytes)).from_buffer_copy(font_bytes)
                            font = raw_api.FPDFText_LoadFont(document, buffer, len(font_bytes), raw_api.FPDF_FONT_TRUETYPE, True)
                            if not font:
                                raise StudioInputError("The installed substitution font could not be embedded.")
                            loaded_fonts[str(font_path)] = (buffer, font)
                        raw_object = raw_api.FPDFPageObj_CreateTextObj(document, loaded_fonts[str(font_path)][1], size / matrix.d)
                        if not raw_object:
                            raise StudioInputError("The replacement text object could not be created.")
                        replacement = pdfium.PdfObject(raw_object, pdf=document)
                        replacement.set_matrix(matrix)
                    _set_text(replacement, text)
                    if not raw_api.FPDFTextObj_SetFontSize(replacement, size / matrix.d):
                        raise StudioInputError("The replacement font size could not be applied.")
                    raw_api.FPDFPageObj_SetFillColor(replacement, *color[:3], round(opacity * 255))
                    if replacement is not original:
                        page.remove_obj(original)
                        original.close()
                        if not raw_api.FPDFPage_InsertObjectAtIndex(page, replacement, object_index):
                            replacement.close()
                            raise StudioInputError("The replacement could not be inserted into the page.")
                        replacement._detach_finalizer()
                        replacement.page = page
                    crop = _box(reader, page_index)
                    left, bottom, right, top = replacement.get_bounds()
                    target_x, target_y = item.get("x", left - crop[0]), item.get("y", crop[3] - top)
                    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (target_x, target_y)):
                        raise StudioInputError("Choose a position inside the page.")
                    shift_x, shift_y = crop[0] + target_x - left, crop[3] - target_y - top
                    replacement.set_matrix(pdfium.PdfMatrix(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e + shift_x, matrix.f + shift_y))
                    left, bottom, right, top = replacement.get_bounds()
                    if left < crop[0] - 0.1 or bottom < crop[1] - 0.1 or right > crop[2] + 0.1 or top > crop[3] + 0.1:
                        raise StudioInputError("The replacement text extends beyond the page. Use a smaller font or move it.")
                page.gen_content()
            finally:
                page.close()
        output = io.BytesIO()
        document.save(output, flags=raw_api.FPDF_NO_INCREMENTAL)
        # Eliminate orphaned original streams/resources from the newly serialized
        # file. No covering rectangle or appended white-box overlay is used.
        cleaned = PdfWriter()
        cleaned.clone_document_from_reader(PdfReader(io.BytesIO(output.getvalue())))
        cleaned.compress_identical_objects(remove_identicals=True, remove_orphans=True)
        final = io.BytesIO()
        cleaned.write(final)
        return final.getvalue(), len(reader.pages)
    except StudioInputError:
        raise
    except Exception:
        raise StudioInputError("This text object could not be replaced. It may use unsupported font encoding or page content.") from None
    finally:
        for buffer, font in loaded_fonts.values():
            raw_api.FPDFFont_Close(font)
        document.close()
