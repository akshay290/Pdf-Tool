"""Honest, local PDF exports to real Office Open XML documents.

Word exports editable existing text without reconstructing the source layout.
PowerPoint uses one rendered page image per slide. Excel exports detected tables.
"""
import io
import re

from docx import Document
from docx.enum.section import WD_SECTION
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.shared import RGBColor as WordColor
from docx.shared import Pt as WordPt
import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
import pdfplumber
from pypdf import PdfReader
import pypdfium2 as pdfium
from pptx import Presentation
from pptx.dml.color import RGBColor as SlideColor
from pptx.enum.text import MSO_AUTO_SIZE
from pptx.util import Pt as SlidePt
from PIL import ImageDraw
from rich_exports import extract_layout, tables_for, RichExportError

MAX_INPUT = 16 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
MAX_RENDER_PIXELS = 12_000_000
MAX_TEXT_CHARACTERS = 2_000_000
MAX_TABLE_CELLS = 200_000
class _ExportError(ValueError):
    pass


XML_UNSAFE = re.compile(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


def _text(value):
    return XML_UNSAFE.sub("", "" if value is None else str(value)).replace("\r\n", "\n").replace("\r", "\n")


def _page_count(raw, limit, label):
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_INPUT:
        raise _ExportError("Choose a readable PDF smaller than 16 MB.")
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            raise _ExportError("This PDF is password-protected. Use Unlock PDF before converting it.")
        count = len(reader.pages)
        if count < 1:
            raise _ExportError("This PDF contains no pages.")
        if count > limit:
            raise _ExportError(f"{label} supports up to {limit} pages per task. Split the PDF first.")
        return count
    except _ExportError:
        raise
    except Exception:
        raise _ExportError("This PDF is damaged or cannot be opened for conversion.") from None


def _open_document(raw):
    try:
        document = pdfium.PdfDocument(raw)
        document.init_forms()
        return document
    except Exception:
        raise _ExportError("This PDF is damaged or cannot be rendered for conversion.") from None


def _result(buffer, count):
    data = buffer.getvalue()
    if len(data) > MAX_OUTPUT:
        raise _ExportError("The converted document exceeds 64 MB. Split the PDF into fewer pages first.")
    return data, count


def _word_frame(paragraph, box):
    props = paragraph._p.get_or_add_pPr()
    frame = OxmlElement("w:framePr")
    attributes = {"w": max(20, round((box[2] - box[0] + 5) * 20)),
                  "h": max(20, round((box[3] - box[1] + 3) * 20)), "hRule": "atLeast",
                  "x": max(0, round(box[0] * 20)), "y": max(0, round(box[1] * 20)),
                  "hAnchor": "page", "vAnchor": "page", "wrap": "none", "hSpace": 0, "vSpace": 0}
    for name, value in attributes.items():
        frame.set(qn("w:" + name), str(value))
    props.append(frame)
    paragraph.paragraph_format.space_before = WordPt(0)
    paragraph.paragraph_format.space_after = WordPt(0)


def _word_run(paragraph, span):
    run = paragraph.add_run(span["text"])
    run.font.name = span["font"]
    run.font.size = WordPt(span["size"])
    run.font.bold, run.font.italic = span["bold"], span["italic"]
    run.font.color.rgb = WordColor(*span["color"])
    if span.get("url"):
        link = OxmlElement("w:hyperlink")
        link.set(qn("r:id"), paragraph.part.relate_to(span["url"], RELATIONSHIP_TYPE.HYPERLINK, is_external=True))
        link.append(run._r)
        paragraph._p.append(link)


def _contains(box, outer):
    return outer[0] - 1 <= (box[0] + box[2]) / 2 <= outer[2] + 1 and outer[1] - 1 <= (box[1] + box[3]) / 2 <= outer[3] + 1


def to_docx(raw):
    """Recover positioned editable text, native tables, links and embedded graphics."""
    count = _page_count(raw, 100, "PDF to Word")
    try:
        pages = extract_layout(raw, limit=100, include_images=True)
        if not any(page["lines"] for page in pages):
            raise _ExportError("This PDF has no selectable text. Run OCR PDF first, then export the searchable PDF to Word.")
        output = Document()
        output.core_properties.title, output.core_properties.author = "Converted PDF", "LocalFold"
        output.styles["Normal"].font.size = WordPt(11)
        for index, page in enumerate(pages):
            section = output.sections[0] if index == 0 else output.add_section(WD_SECTION.NEW_PAGE)
            section.page_width, section.page_height = WordPt(page["width"]), WordPt(page["height"])
            section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = WordPt(12)
            for line in page["lines"]:
                if any(_contains(line["bbox"], table["bbox"]) for table in page["tables"]):
                    continue
                paragraph = output.add_paragraph()
                _word_frame(paragraph, line["bbox"])
                paragraph.paragraph_format.line_spacing = WordPt(max(1, line["size"] * 1.05))
                for span in line["spans"]:
                    _word_run(paragraph, span)
            for source in page["tables"]:
                rows = source["rows"]
                columns = max(len(row) for row in rows)
                table = output.add_table(rows=len(rows), cols=columns)
                table.style, table.autofit = "Table Grid", False
                x0, top, x1, bottom = source["bbox"]
                position = OxmlElement("w:tblpPr")
                for name, value in {"vertAnchor": "page", "horzAnchor": "page", "tblpX": round(x0 * 20),
                                    "tblpY": round(top * 20), "leftFromText": 0, "rightFromText": 0,
                                    "topFromText": 0, "bottomFromText": 0}.items():
                    position.set(qn("w:" + name), str(value))
                table._tbl.tblPr.insert(0, position)
                boundaries = sorted(set([cell[0] for cell in source["cells"] if cell] + [x1]))
                widths = [boundaries[i + 1] - boundaries[i] for i in range(len(boundaries) - 1)]
                if len(widths) != columns:
                    widths = [(x1 - x0) / columns] * columns
                for row_index, row in enumerate(rows):
                    for column_index in range(columns):
                        cell = table.cell(row_index, column_index)
                        cell.width = WordPt(max(1, widths[column_index]))
                        cell.text = row[column_index] if column_index < len(row) else ""
                        for paragraph in cell.paragraphs:
                            paragraph.paragraph_format.space_after = WordPt(0)
                            for run in paragraph.runs:
                                run.font.size = WordPt(10)
                for column_index, width in enumerate(widths):
                    table.columns[column_index].width = WordPt(max(1, width))
            for image in page["images"]:
                # OCR scans already contain their text in pixels; embedding a
                # whole scan behind recovered Word paragraphs duplicates it.
                if image["coverage"] > .7 and page["lines"]:
                    continue
                x0, top, x1, bottom = image["bbox"]
                paragraph = output.add_paragraph()
                _word_frame(paragraph, image["bbox"])
                paragraph.add_run().add_picture(io.BytesIO(image["bytes"]), width=WordPt(x1 - x0), height=WordPt(bottom - top))
            anchor = output.add_paragraph()
            anchor.paragraph_format.space_after = WordPt(0)
            anchor.paragraph_format.line_spacing = WordPt(1)
            anchor.add_run().font.size = WordPt(1)
        buffer = io.BytesIO()
        output.save(buffer)
        return _result(buffer, count)
    except (_ExportError, RichExportError) as error:
        raise _ExportError(str(error)) from None
    except Exception:
        raise _ExportError("The PDF layout could not be converted to Word. Try a simpler PDF or run OCR first.") from None


def _slide_size(width, height):
    # PowerPoint requires each dimension between 1 and 56 inches. Use the first
    # page's shape where possible; exceptional page shapes fit standard slides.
    slide_height = 540.0
    slide_width = slide_height * width / height
    if slide_width < 72:
        factor = 72 / slide_width
        slide_width *= factor
        slide_height *= factor
    elif slide_width > 4032:
        factor = 4032 / slide_width
        slide_width *= factor
        slide_height *= factor
    if slide_height < 72 or slide_height > 4032:
        return 960.0, 540.0
    return slide_width, slide_height


def to_pptx(raw):
    """Render page graphics after removing PDF text, then add editable text boxes."""
    count = _page_count(raw, 20, "PDF to PowerPoint")
    document = _open_document(raw)
    output = Presentation()
    output.core_properties.title = "Editable PDF slides"
    output.core_properties.author = "LocalFold"
    image_bytes = 0
    try:
        layouts = extract_layout(raw, limit=20)
        for index in range(count):
            page = document[index]
            bitmap = None
            image = None
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0 or width * height * 4 > MAX_RENDER_PIXELS:
                    raise _ExportError("A PDF page is too large to render for PowerPoint. Use a smaller page size.")
                if index == 0:
                    slide_width, slide_height = _slide_size(width, height)
                    output.slide_width = SlidePt(slide_width)
                    output.slide_height = SlidePt(slide_height)
                layout = layouts[index]
                invisible = False
                if layout["lines"]:
                    # The installed PDFium also supports removing text nested in
                    # Form XObjects. Take the object list before modifying it.
                    objects = list(page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_TEXT], max_depth=15))
                    for item in objects:
                        invisible = invisible or pdfium.raw.FPDFTextObj_GetTextRenderMode(item.raw) in (3, 7)
                        page.remove_obj(item)
                        item.close()
                    if objects:
                        page.gen_content()
                bitmap = page.render(scale=2)
                image = bitmap.to_pil().convert("RGB")
                scan_cleanup = invisible and any(item["coverage"] > .65 for item in layout["images"])
                if scan_cleanup:
                    # An OCR layer may sit over a scanned image. Remove the old
                    # glyph pixels in that case before adding editable text.
                    # Edge sampling keeps plain colored paper backgrounds.
                    painter = ImageDraw.Draw(image)
                    for line in layout["lines"]:
                        x0, y0, x1, y1 = [round(value * 2) for value in line["bbox"]]
                        x0, y0 = max(1, x0 - 1), max(1, y0 - 1)
                        x1, y1 = min(image.width - 2, x1 + 1), min(image.height - 2, y1 + 1)
                        if x1 <= x0 or y1 <= y0:
                            continue
                        samples = [image.getpixel((x, y)) for x in range(x0, x1 + 1, max(1, (x1 - x0) // 20)) for y in (y0 - 1, y1 + 1)]
                        background = tuple(sorted(sample[channel] for sample in samples)[len(samples) // 2] for channel in range(3))
                        painter.rectangle((x0, y0, x1, y1), fill=background)
                image_buffer = io.BytesIO()
                image.save(image_buffer, format="JPEG", quality=90, optimize=True)
                image_bytes += image_buffer.tell()
                if image_bytes > MAX_OUTPUT:
                    raise _ExportError("The rendered slides exceed 64 MB. Split the PDF into fewer pages first.")
                slide = output.slides.add_slide(output.slide_layouts[6])
                scale = min(slide_width / width, slide_height / height)
                display_width, display_height = width * scale, height * scale
                image_buffer.seek(0)
                slide.shapes.add_picture(
                    image_buffer,
                    SlidePt((slide_width - display_width) / 2),
                    SlidePt((slide_height - display_height) / 2),
                    width=SlidePt(display_width), height=SlidePt(display_height),
                )
                left, top = (slide_width - display_width) / 2, (slide_height - display_height) / 2
                for line in layout["lines"]:
                    x0, y0, x1, y1 = line["bbox"]
                    shape = slide.shapes.add_textbox(SlidePt(left + x0 * scale), SlidePt(top + y0 * scale),
                                                     SlidePt(max(1, (x1 - x0 + 5) * scale)),
                                                     SlidePt(max(1, (y1 - y0 + line["size"] * .35) * scale)))
                    shape.name = "Editable PDF text"
                    frame = shape.text_frame
                    frame.margin_left = frame.margin_top = frame.margin_right = frame.margin_bottom = 0
                    frame.word_wrap, frame.auto_size = False, MSO_AUTO_SIZE.NONE
                    paragraph = frame.paragraphs[0]
                    paragraph.space_before = paragraph.space_after = SlidePt(0)
                    for span in line["spans"]:
                        run = paragraph.add_run()
                        run.text = span["text"]
                        run.font.name, run.font.size = span["font"], SlidePt(span["size"] * scale)
                        run.font.bold, run.font.italic = span["bold"], span["italic"]
                        run.font.color.rgb = SlideColor(*span["color"])
                        if span.get("url"):
                            run.hyperlink.address = span["url"]
                if scan_cleanup:
                    slide.notes_slide.notes_text_frame.text = "OCR text is editable. Cleanup of the scanned background is approximate; check complex backgrounds and diagrams."
            finally:
                if image is not None:
                    image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
        buffer = io.BytesIO()
        output.save(buffer)
        return _result(buffer, count)
    except (_ExportError, RichExportError) as error:
        raise _ExportError(str(error)) from None
    except Exception:
        raise _ExportError("The PDF pages could not be converted to slides. Try a simpler PDF.") from None
    finally:
        document.close()


def to_xlsx(raw):
    """Export detected PDF tables, one worksheet per table, preserving cell text."""
    count = _page_count(raw, 30, "PDF tables to Excel")
    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    workbook.properties.creator = "LocalFold"
    workbook.properties.title = "PDF table export"
    total_cells = 0
    try:
        recovered = extract_layout(raw, limit=30)
        with pdfplumber.open(io.BytesIO(raw)) as document:
            for page_index, page in enumerate(document.pages, start=1):
                for table_index, table in enumerate(recovered[page_index - 1]["tables"], start=1):
                    rows = table["rows"]
                    if not rows or not any(_text(value).strip() for row in rows for value in row):
                        continue
                    columns = max(len(row) for row in rows)
                    total_cells += len(rows) * columns
                    if columns > 16384 or len(rows) > 1_048_576 or total_cells > MAX_TABLE_CELLS:
                        raise _ExportError("The detected tables are too large for one Excel export. Split the PDF first.")
                    sheet = workbook.create_sheet(f"Page {page_index} Table {table_index}")
                    column_lengths = [0] * columns
                    for row_index, row in enumerate(rows, start=1):
                        for column_index, value in enumerate(row, start=1):
                            text = _text(value)
                            if len(text) > 32767:
                                raise _ExportError("A detected table cell exceeds Excel's text limit. Try a smaller table.")
                            cell = sheet.cell(row_index, column_index, text)
                            # PDF cells are untrusted document text. Keep strings
                            # such as '=SUM(...)' literal when opened in Excel.
                            cell.data_type = "s"
                            cell.alignment = Alignment(vertical="top", wrap_text=True)
                            if row_index == 1:
                                cell.font = Font(bold=True, color="FFFFFF")
                                cell.fill = PatternFill("solid", fgColor="1F4E78")
                            column_lengths[column_index - 1] = max(
                                column_lengths[column_index - 1],
                                max((len(line) for line in text.split("\n")), default=0),
                            )
                    for index, length in enumerate(column_lengths, start=1):
                        sheet.column_dimensions[get_column_letter(index)].width = min(50, max(10, length + 2))
                    sheet.freeze_panes = "A2"
                page.close()
        if not workbook.worksheets:
            raise _ExportError("No extractable tables were found. Use a PDF with selectable text arranged in rows and columns, or run OCR first for a scan.")
        buffer = io.BytesIO()
        workbook.save(buffer)
        return _result(buffer, count)
    except _ExportError:
        raise
    except Exception:
        raise _ExportError("The PDF tables could not be converted to Excel. Try a PDF with clear table borders and selectable text.") from None
    finally:
        workbook.close()
