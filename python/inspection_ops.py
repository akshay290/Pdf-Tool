"""Local previews, image extraction and visual comparison; no remote services."""
import base64
import html
import io
import json
import re
import zipfile

from PIL import Image, ImageChops, ImageEnhance
from pypdf import PdfReader
from pypdf.generic import ContentStream
import pypdfium2 as pdfium

MAX_OUTPUT = 64 * 1024 * 1024
MAX_PIXELS = 12_000_000


class InspectionError(ValueError):
    pass


def _reader(raw):
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            raise InspectionError("Unlock this PDF using its password before previewing or extracting content.")
        if not reader.pages:
            raise InspectionError("This PDF contains no pages.")
        return reader
    except InspectionError:
        raise
    except Exception:
        raise InspectionError("This PDF cannot be opened by the local engine.") from None


def _render(document, index, dpi, unrotate=False):
    page = document[index]
    bitmap = None
    rotation = None
    try:
        rotation = page.get_rotation()
        if unrotate:
            page.set_rotation(0)
        width, height = page.get_size()
        scale = dpi / 72
        if min(width, height) <= 0 or width * height * scale * scale > MAX_PIXELS:
            raise InspectionError("This page is too large to preview at the requested resolution.")
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        return image, width, height, rotation
    finally:
        if bitmap is not None:
            bitmap.close()
        if unrotate and rotation is not None:
            page.set_rotation(rotation)
        page.close()


def preview(raw, payload):
    reader = _reader(raw)
    pages = payload.get("pages", [1])
    dpi = payload.get("dpi", 72)
    if not isinstance(pages, list) or not 1 <= len(pages) <= 20 or any(type(page) is not int or page < 1 or page > len(reader.pages) for page in pages):
        raise InspectionError("Choose between 1 and 20 valid page numbers for a preview.")
    if dpi not in (36, 48, 50, 72, 96, 120):
        raise InspectionError("Choose a supported preview resolution.")
    results, total = [], 0
    with pdfium.PdfDocument(raw) as document:
        document.init_forms()
        for number in pages:
            image, width, height, rotation = _render(document, number - 1, dpi, unrotate=True)
            try:
                output = io.BytesIO()
                image.save(output, format="PNG", optimize=True)
                data = output.getvalue()
                total += len(data)
                if total > 30 * 1024 * 1024:
                    raise InspectionError("These previews exceed 30 MB. Choose fewer pages or lower resolution.")
                results.append({"page": number, "data": base64.b64encode(data).decode("ascii"), "width": width, "height": height, "rotation": rotation})
            finally:
                image.close()
    return {"pages": results, "pageCount": len(reader.pages)}


def _check_images(page, reader):
    visited = set()
    def dimensions(image):
        width = int(image.get("/Width", image.get("/W", 0)))
        height = int(image.get("/Height", image.get("/H", 0)))
        if min(width, height) < 1 or width * height > MAX_PIXELS:
            raise InspectionError("An embedded image exceeds the 12 megapixel extraction limit. Use page rendering at a lower resolution instead.")
    def inspect(container, depth=0):
        if depth > 16:
            raise InspectionError("Embedded image nesting is too deep to extract safely.")
        resources = container.get("/Resources", {})
        if hasattr(resources, "get_object"):
            resources = resources.get_object()
        objects = resources.get("/XObject", {})
        if hasattr(objects, "get_object"):
            objects = objects.get_object()
        for reference in objects.values():
            image = reference.get_object()
            key = id(image)
            if key in visited:
                continue
            visited.add(key)
            if len(visited) > 3000:
                raise InspectionError("This PDF contains too many graphics objects. Split it before extraction.")
            if image.get("/Subtype") == "/Image":
                dimensions(image)
                mask = image.get("/SMask")
                if mask is not None:
                    dimensions(mask.get_object())
            elif image.get("/Subtype") == "/Form":
                inspect(image, depth + 1)
        content = container.get_contents() if hasattr(container, "get_contents") else ContentStream(container, reader)
        if content:
            for operands, operator in content.operations:
                if operator == b"INLINE IMAGE":
                    dimensions(operands["settings"])
    inspect(page)


def extract_images(raw):
    reader = _reader(raw)
    if len(reader.pages) > 200:
        raise InspectionError("Image extraction supports up to 200 pages. Split this PDF first.")
    output, manifest, total = io.BytesIO(), [], 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for number, page in enumerate(reader.pages, 1):
            _check_images(page, reader)
            for item in page.images:
                if len(manifest) >= 1000:
                    raise InspectionError("This PDF has more than 1000 embedded images. Split it first.")
                data = item.data
                total += len(data)
                if total > MAX_OUTPUT:
                    raise InspectionError("Extracted images exceed 64 MB. Split this PDF first.")
                name = re.sub(r"[^a-zA-Z0-9._-]", "-", item.name)[-100:] or "image.bin"
                filename = f"images/page-{number:04d}-{len(manifest)+1:04d}-{name}"
                archive.writestr(filename, data)
                manifest.append({"page": number, "file": filename, "bytes": len(data)})
        if not manifest:
            raise InspectionError("No embedded raster images were found. Use PDF to images to render page graphics instead.")
        archive.writestr("manifest.json", json.dumps({"images": manifest}, indent=2))
    data = output.getvalue()
    if len(data) > MAX_OUTPUT:
        raise InspectionError("The image archive exceeds 64 MB. Split this PDF first.")
    return data, len(reader.pages)


def visual_compare(first, second):
    before_reader, after_reader = _reader(first), _reader(second)
    count = max(len(before_reader.pages), len(after_reader.pages))
    if count > 40:
        raise InspectionError("Visual comparison supports up to 40 pages per PDF. Split longer documents first.")
    output, reports, total = io.BytesIO(), [], 0
    with pdfium.PdfDocument(first) as before, pdfium.PdfDocument(second) as after, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        before.init_forms()
        after.init_forms()
        for index in range(count):
            images = []
            dimensions = []
            for document in (before, after):
                if index < len(document):
                    image, width, height, _ = _render(document, index, 72)
                    images.append(image)
                    dimensions.append((width, height))
                else:
                    images.append(None)
                    dimensions.append(None)
            width = max(image.width for image in images if image is not None)
            height = max(image.height for image in images if image is not None)
            if width * height > MAX_PIXELS:
                for image in images:
                    if image is not None:
                        image.close()
                raise InspectionError("A comparison page is too large to render safely.")
            canvases = []
            for image in images:
                canvas = Image.new("RGB", (width, height), "white")
                if image is not None:
                    canvas.paste(image, (0, 0))
                    image.close()
                canvases.append(canvas)
            diff = ImageChops.difference(canvases[0], canvases[1])
            red, green, blue = diff.split()
            mask = ImageChops.lighter(ImageChops.lighter(red, green), blue).point(lambda pixel: 255 if pixel > 20 else 0)
            changed = mask.histogram()[255]
            visual = ImageEnhance.Color(canvases[1]).enhance(0.2)
            visual.paste(Image.new("RGB", visual.size, "#e63956"), mask=mask)
            filenames = []
            for label, image in [("before", canvases[0]), ("after", canvases[1]), ("difference", visual)]:
                buffer = io.BytesIO()
                image.save(buffer, format="PNG", optimize=True)
                data = buffer.getvalue()
                total += len(data)
                if total > MAX_OUTPUT:
                    raise InspectionError("The visual report exceeds 64 MB. Compare fewer pages.")
                filename = f"pages/{index+1:04d}-{label}.png"
                archive.writestr(filename, data)
                filenames.append(filename)
                image.close()
            diff.close()
            mask.close()
            for channel in (red, green, blue):
                channel.close()
            reports.append({"page": index+1, "changedPixels": changed, "changedPercent": round(changed * 100 / (width*height), 4),
                            "sizeChanged": dimensions[0] != dimensions[1], "added": index >= len(before), "removed": index >= len(after), "images": filenames})
        archive.writestr("report.json", json.dumps({"pages": reports, "threshold": 20, "dpi": 72}, indent=2))
        sections = []
        for item in reports:
            labels = ["Original", "Revised", "Differences highlighted"]
            pictures = "".join(f'<figure><figcaption>{label}</figcaption><img src="{html.escape(filename)}" alt="Page {item["page"]}: {label}"></figure>' for label, filename in zip(labels, item["images"]))
            note = " · page added" if item["added"] else " · page removed" if item["removed"] else " · page size changed" if item["sizeChanged"] else ""
            sections.append(f'<section><h2>Page {item["page"]} — {item["changedPercent"]}% changed{note}</h2><div class="pages">{pictures}</div></section>')
        archive.writestr("index.html", '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LocalFold visual comparison</title><style>body{font:16px system-ui;margin:32px;background:#f7f8f5;color:#172c26}h1{font-size:30px}.pages{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}figure{margin:0}img{width:100%;background:white;border:1px solid #ccc}figcaption{margin:8px 0}section{margin:36px 0}@media(max-width:700px){.pages{grid-template-columns:1fr}}</style><h1>Visual PDF comparison</h1><p>Pages compared at 72 DPI. Red marks show pixel changes; page movement and rendering differences may also be highlighted. Extract this ZIP and open index.html. No internet connection is needed.</p>' + "".join(sections) + '</html>')
    result = output.getvalue()
    if len(result) > MAX_OUTPUT:
        raise InspectionError("The visual report exceeds 64 MB. Compare fewer pages.")
    return result, count
