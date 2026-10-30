"""Bounded, local target-size raster compression. Never discard frames or alpha."""
import base64
import io
import math
import time
import warnings

from PIL import Image, ImageChops, ImageCms, ImageOps, ImageStat, features

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pillow_heif = None

MAX_INPUT = 16 * 1024 * 1024
MAX_PIXELS = 50_000_000
MAX_TOTAL_PIXELS = 60_000_000
MAX_FRAMES = 120
MAX_ATTEMPTS = 52
MAX_SECONDS = 65
SUPPORTED = {"JPEG", "PNG", "WEBP", "AVIF", "GIF", "BMP", "TIFF", "HEIF", "ICO", "JPEG2000",
             "PPM", "PCX", "TGA", "DDS", "QOI", "PSD", "DIB", "ICNS", "CUR", "SGI", "SUN", "XBM", "XPM"}
EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "AVIF": "avif", "GIF": "gif",
              "BMP": "bmp", "TIFF": "tiff", "ICO": "ico", "JPEG2000": "jp2", "PPM": "ppm",
              "PCX": "pcx", "TGA": "tga", "DDS": "dds", "QOI": "qoi", "PSD": "psd", "DIB": "dib",
              "ICNS": "icns", "CUR": "cur", "SGI": "sgi", "SUN": "ras", "XBM": "xbm", "XPM": "xpm", "HEIF": "heic"}
MEDIA = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "AVIF": "image/avif",
         "GIF": "image/gif", "BMP": "image/bmp", "TIFF": "image/tiff", "ICO": "image/x-icon",
         "JPEG2000": "image/jp2", "PPM": "image/x-portable-pixmap", "PCX": "image/x-pcx",
         "TGA": "image/x-tga", "DDS": "image/vnd-ms.dds", "QOI": "image/qoi", "PSD": "image/vnd.adobe.photoshop", "HEIF": "image/heic"}


class ImageCompressionError(ValueError):
    pass


def _decode_file(file):
    if not isinstance(file, dict) or not isinstance(file.get("data"), str):
        raise ImageCompressionError("Choose an image file to compress.")
    if not file["data"] or len(file["data"]) > MAX_INPUT * 4 // 3 + 8:
        raise ImageCompressionError("Choose an image no larger than 16 MB.")
    try:
        raw = base64.b64decode(file["data"], validate=True)
    except Exception:
        raise ImageCompressionError("The image data could not be read.") from None
    if not raw or len(raw) > MAX_INPUT:
        raise ImageCompressionError("Choose an image no larger than 16 MB.")
    return raw


def _read_frames(raw):
    frames, durations = [], []
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                source_format = image.format
                # Exclude vector/external-process formats before accessing frame metadata.
                if source_format not in SUPPORTED:
                    raise ImageCompressionError("Use a supported raster image such as JPG, PNG, WebP, AVIF, GIF, BMP, TIFF or ICO. SVG, camera RAW and this format are not supported.")
                animation = {"loop": image.info.get("loop"), "default_image": bool(image.info.get("default_image", False))}
                profile = image.info.get("icc_profile")
                if profile and len(profile) > 1024 * 1024:
                    raise ImageCompressionError("The image color profile is too large for local compression.")
                total = 0
                for index in range(MAX_FRAMES + 1):
                    try:
                        image.seek(index)
                    except EOFError:
                        break
                    if index == MAX_FRAMES:
                        raise ImageCompressionError(f"This image has more than {MAX_FRAMES} frames or pages. Use a shorter animation or split the TIFF first.")
                    width, height = image.size
                    if min(width, height) < 1 or max(width, height) > 30_000 or width * height > MAX_PIXELS:
                        raise ImageCompressionError("Use images with at most 50 million pixels per frame and no side above 30000 pixels.")
                    total += width * height
                    if total > MAX_TOTAL_PIXELS:
                        raise ImageCompressionError("The combined animation or TIFF pages exceed 60 million pixels. Use fewer or smaller frames.")
                    image.load()
                    duration = image.info.get("duration", 100)
                    durations.append(max(1, round(duration)) if isinstance(duration, (int, float)) and math.isfinite(duration) else 100)
                    oriented = ImageOps.exif_transpose(image)
                    try:
                        if source_format == "TIFF" and hasattr(image, "tag_v2") and oriented.mode in {"RGB", "RGBA"} and max(image.tag_v2.get(258, (8,))) > 8:
                            raise ImageCompressionError("High-bit-depth color TIFF needs a precision-preserving image editor. Export an 8-bit copy before compressing it here.")
                        if oriented.mode == "F" or (oriented.mode == "I" and not (0 <= oriented.getextrema()[0] <= oriented.getextrema()[1] <= 65535)):
                            raise ImageCompressionError("Floating-point or 32-bit scientific image data cannot be compressed here without changing its precision. Export a display copy first.")
                        if oriented.mode.startswith("I;16") or oriented.mode == "I":
                            converted = oriented.convert("I;16")
                        elif oriented.mode == "CMYK" and profile:
                            try:
                                converted = ImageCms.profileToProfile(oriented, io.BytesIO(profile), ImageCms.createProfile("sRGB"), outputMode="RGB")
                            except Exception:
                                converted = oriented.convert("RGB")
                        else:
                            has_alpha = "A" in oriented.getbands() or "transparency" in oriented.info
                            converted = oriented.convert("RGBA" if has_alpha else "RGB")
                        # Discard inherited EXIF/GPS/XMP; the safe ICC profile is passed explicitly.
                        converted.info.clear()
                        frames.append(converted)
                    finally:
                        if oriented is not image:
                            oriented.close()
                if not frames:
                    raise ImageCompressionError("This image contains no readable frames.")
                if source_format != "TIFF" and any(frame.size != frames[0].size for frame in frames):
                    raise ImageCompressionError("This animation uses inconsistent frame dimensions. Export a standard GIF, WebP or APNG first.")
                # ImageCms converted CMYK to sRGB, so retaining its old CMYK profile would mislabel RGB.
                if image.mode == "CMYK":
                    profile = None
                alpha = any("A" in frame.getbands() and frame.getextrema()[-1][0] < 255 for frame in frames)
                return frames, durations, animation, source_format, profile, alpha
    except ImageCompressionError:
        for frame in frames:
            frame.close()
        raise
    except Exception:
        for frame in frames:
            frame.close()
        raise ImageCompressionError("This image is damaged, unsupported or too large to decode safely.") from None


def _loss_score(original, encoded):
    """Compare a small decoded thumbnail, including alpha."""
    reference = comparison = None
    try:
        scale = min(1, 192 / original.width, 192 / original.height)
        size = (max(1, round(original.width * scale)), max(1, round(original.height * scale)))
        reduced = original.resize(size, Image.Resampling.LANCZOS, reducing_gap=3)
        try:
            reference = reduced.convert("RGBA")
        finally:
            reduced.close()
        with Image.open(io.BytesIO(encoded)) as image:
            image.thumbnail(size, Image.Resampling.LANCZOS, reducing_gap=3)
            comparison = image.convert("RGBA")
            if comparison.size != reference.size:
                resized = comparison.resize(reference.size, Image.Resampling.LANCZOS)
                comparison.close()
                comparison = resized
            delta = ImageChops.difference(reference, comparison)
            try:
                stats = ImageStat.Stat(delta)
                return sum(value * value for value in stats.rms) / 4
            finally:
                delta.close()
    except Exception:
        return float("inf")
    finally:
        if reference is not None:
            reference.close()
        if comparison is not None:
            comparison.close()


def _encode(frames, fmt, quality, durations, animation, profile, lossless=False):
    output = io.BytesIO()
    options = {}
    if profile and fmt in {"JPEG", "PNG", "WEBP", "AVIF", "TIFF"}:
        options["icc_profile"] = profile
    if fmt == "JPEG":
        options.update(quality=quality, optimize=True, progressive=True, subsampling=0 if quality >= 85 else 2)
    elif fmt == "PNG":
        options.update(optimize=True, compress_level=9)
    elif fmt == "WEBP":
        options.update(quality=quality, method=5, lossless=lossless, exact=True)
    elif fmt == "AVIF":
        large = frames[0].width * frames[0].height > 12_000_000
        options.update(quality=quality, speed=10 if large else 8, max_threads=2,
                       subsampling="4:4:4" if quality >= 85 else "4:2:0")
    elif fmt == "TIFF":
        options.update(compression="tiff_adobe_deflate")
    if len(frames) > 1:
        options.update(save_all=True, append_images=frames[1:])
        if fmt != "TIFF":
            # An absent GIF loop extension means play once; loop=0 means forever.
            # APNG's optional default image is a poster, not animation frame zero.
            poster = fmt == "PNG" and animation["default_image"]
            options["duration"] = durations[1:] if poster else durations
            if animation["loop"] is not None:
                options["loop"] = animation["loop"]
            if poster:
                options["default_image"] = True
        if fmt == "GIF":
            options.update(optimize=True, disposal=2)
    converted = frames[0].convert("RGB") if fmt == "JPEG" and frames[0].mode != "RGB" else None
    try:
        (converted or frames[0]).save(output, format=fmt, **options)
    finally:
        if converted is not None:
            converted.close()
    data = output.getvalue()
    if len(frames) > 1:
        # Some encoders collapse equal frames. Keep the promised frame count exact.
        with Image.open(io.BytesIO(data)) as check:
            check.seek(len(frames) - 1)
            try:
                check.seek(len(frames))
                raise ValueError("Encoded frame count differs from the source.")
            except EOFError:
                pass
    return data


def compress_image(payload):
    raw = _decode_file(payload.get("file"))
    target = payload.get("targetBytes")
    if type(target) is not int or not 1000 <= target <= MAX_INPUT:
        raise ImageCompressionError("Choose a target maximum between 1000 and 16777216 bytes, as a whole number.")
    selected = payload.get("outputFormat", payload.get("format", "auto"))
    if not isinstance(selected, str) or selected not in {"auto", "jpeg", "png", "webp", "avif"}:
        raise ImageCompressionError("Choose automatic, JPG, PNG, WebP or AVIF output.")
    frames, durations, animation, original_format, profile, alpha = _read_frames(raw)
    started = time.monotonic()
    attempts = 0
    deadline_reached = False
    original_sizes = [frame.size for frame in frames]
    requested = None if selected == "auto" else selected.upper()
    best_under = None
    best_any = None

    def candidate(data, fmt, quality=None, resized=False, lossless=False, dimensions=None):
        nonlocal best_under, best_any
        item = {"bytes": data, "format": fmt, "source_format": original_format, "quality": quality, "resized": resized,
                "width": (dimensions or original_sizes[0])[0], "height": (dimensions or original_sizes[0])[1],
                "score": None, "lossless": lossless}
        if best_any is None or len(data) < len(best_any["bytes"]):
            best_any = item
        if len(data) <= target:
            item["score"] = 0 if lossless and not resized else _loss_score(frames[0], data)
            rank = (resized, item["score"], -(item["width"] * item["height"]), len(data))
            if best_under is None or rank < best_under["rank"]:
                item["rank"] = rank
                best_under = item
        return item

    def available():
        nonlocal deadline_reached
        deadline_reached = time.monotonic() - started >= MAX_SECONDS
        return attempts < MAX_ATTEMPTS and not deadline_reached

    def trial(current, fmt, quality=95, lossless=False):
        nonlocal attempts
        if not available():
            return None
        attempts += 1
        try:
            data = _encode(current, fmt, quality, durations, animation, profile, lossless)
            # Never enlarge an auto result just to make a different format.
            if len(data) > MAX_INPUT or (requested is None and len(data) > len(raw)):
                return None
            return candidate(data, fmt, quality if fmt in {"JPEG", "WEBP", "AVIF"} and not lossless else None,
                             current[0].size != frames[0].size, lossless, current[0].size)
        except (OSError, ValueError, RuntimeError):
            return None

    def search(current, fmt):
        if fmt not in {"JPEG", "WEBP", "AVIF"}:
            return trial(current, fmt, lossless=fmt in {"PNG", "TIFF"})
        high = trial(current, fmt, 95)
        if high is not None and len(high["bytes"]) <= target:
            return high
        floor = 50
        low = trial(current, fmt, floor)
        if low is None or len(low["bytes"]) > target:
            return low
        left, right = floor + 1, 94
        while left <= right and available():
            middle = (left + right) // 2
            item = trial(current, fmt, middle)
            if item is None or len(item["bytes"]) > target:
                right = middle - 1
            else:
                left = middle + 1
        return best_under or low

    try:
        high_precision = any(frame.mode.startswith("I;16") for frame in frames)
        if high_precision and requested not in {None, "PNG"}:
            raise ImageCompressionError("Choose automatic or PNG output to preserve this image's 16-bit grayscale precision.")
        if requested == "JPEG" and alpha:
            raise ImageCompressionError("JPG cannot retain transparency. Choose automatic, PNG, WebP or AVIF output.")
        if len(frames) > 1 and requested == "JPEG":
            raise ImageCompressionError("JPG cannot retain animation or multiple pages. Choose automatic, PNG, WebP or AVIF.")
        if len(frames) > 1 and requested == "AVIF":
            raise ImageCompressionError("Choose automatic, PNG or WebP to retain animation timing and looping. This AVIF encoder cannot preserve every loop setting.")
        if len(frames) > 1 and original_format in {"TIFF", "HEIF"} and requested is not None:
            raise ImageCompressionError("Use automatic output to preserve every TIFF or HEIF page. Split its pages before changing image formats.")
        if len(frames) > 1 and original_format in {"GIF", "PNG", "WEBP", "AVIF"} and requested not in {None, original_format}:
            raise ImageCompressionError("Choose automatic output or the source animation format to retain its exact looping, timing and poster behavior. Cross-format animation conversion is not supported.")
        if requested == "WEBP" and not features.check("webp"):
            raise ImageCompressionError("This local image engine does not have WebP encoding installed.")
        if requested == "AVIF" and not features.check("avif"):
            raise ImageCompressionError("This local image engine does not have AVIF encoding installed.")
        if requested is None or requested == original_format:
            candidate(raw, original_format, lossless=True)
            if len(raw) <= target:
                return _package(best_under, raw, target, len(frames), original_sizes, attempts, True, alpha)
        if original_format == "AVIF" and len(frames) > 1:
            if requested is not None:
                raise ImageCompressionError("Animated AVIF is preserved only in automatic mode because the local decoder cannot reliably expose its loop setting.")
            result = _package(best_any, raw, target, len(frames), original_sizes, attempts, True, alpha)
            result["resultMessage"] += " Animated AVIF was retained unchanged to preserve every timing and loop setting."
            return result
        if requested:
            formats = [requested]
        elif high_precision:
            formats = ["TIFF"] if len(frames) > 1 else ["PNG"]
        elif len(frames) > 1:
            formats = ["TIFF"] if original_format == "HEIF" else [original_format] if original_format in {"GIF", "PNG", "WEBP", "AVIF", "TIFF"} else []
        else:
            formats = ["PNG"] if frames[0].width * frames[0].height <= 12_000_000 or alpha else []
            if not alpha:
                formats.append("JPEG")
            if features.check("webp"):
                formats.append("WEBP")
            if features.check("avif"):
                formats.append("AVIF")
        if not formats:
            raise ImageCompressionError("This multi-frame format cannot be compressed without losing pages. Export a multipage TIFF or animated GIF/WebP first.")
        # Pixel-preserving candidates precede any lossy codec or dimension change.
        for fmt in formats:
            if fmt in {"PNG", "TIFF"}:
                trial(frames, fmt, lossless=True)
            elif fmt == "WEBP" and frames[0].width * frames[0].height <= 12_000_000:
                trial(frames, fmt, lossless=True)
        if best_under and best_under["lossless"]:
            return _package(best_under, raw, target, len(frames), original_sizes, attempts, False, alpha)
        for fmt in formats:
            if available():
                search(frames, fmt)
        if best_under:
            return _package(best_under, raw, target, len(frames), original_sizes, attempts, False, alpha)
        # Quality is exhausted at the original resolution before proportional resizing.
        # Stop at a 64-pixel long edge rather than claiming unreadably tiny output is clear.
        for factor in (.85, .7, .55, .4, .28, .18, .1):
            if not available() or max(frames[0].size) * factor < 64:
                break
            current = []
            for frame in frames:
                size = (max(1, round(frame.width * factor)), max(1, round(frame.height * factor)))
                if frame.mode.startswith("I;16"):
                    working = frame.convert("I")
                    try:
                        current.append(working.resize(size, Image.Resampling.LANCZOS).convert("I;16"))
                    finally:
                        working.close()
                else:
                    current.append(frame.resize(size, Image.Resampling.LANCZOS))
            try:
                for fmt in formats:
                    if available():
                        search(current, fmt)
                if best_under:
                    break
            finally:
                for frame in current:
                    frame.close()
        if best_any is None:
            raise ImageCompressionError("This image could not be encoded in the selected format. Choose automatic output or another format.")
        return _package(best_under or best_any, raw, target, len(frames), original_sizes, attempts, False, alpha, deadline_reached)
    finally:
        for frame in frames:
            frame.close()


def _package(item, raw, target, count, original_sizes, attempts, original, alpha, timed_out=False):
    data, fmt = item["bytes"], item["format"]
    original = data == raw
    reached = len(data) <= target
    if original and reached:
        message = "This image is already below the target maximum. Its original bytes, metadata and every frame were preserved."
    elif original:
        message = "The target maximum could not be reached within the local clarity and processing limits. The original was retained because no tested valid result was smaller."
    elif reached:
        message = "The target maximum was reached. "
        message += "Original pixel dimensions were retained." if not item["resized"] else "Dimensions were reduced proportionally with Lanczos resampling to meet the maximum."
    else:
        message = "The target maximum could not be reached within the local clarity and processing limits. The smallest tested valid result was returned."
        if timed_out:
            message += " The bounded search time was reached."
    if count > 1:
        message += f" All {count} frames or pages were retained."
    if alpha:
        message += " Transparency was retained."
    if not original and item.get("source_format") in {"PSD", "ICO", "ICNS", "CUR"}:
        message += " The rendered composite or largest icon was compressed; editable layers and alternate icon sizes are not retained."
    return {"data": base64.b64encode(data).decode("ascii"), "name": f"localfold-compressed.{EXTENSIONS.get(fmt, fmt.lower())}",
            "mediaType": MEDIA.get(fmt, "application/octet-stream"), "pageCount": count,
            "inputBytes": len(raw), "outputBytes": len(data), "reduced": len(data) < len(raw),
            "targetBytes": target, "targetReached": reached, "rasterized": False,
            "imageWidth": item["width"], "imageHeight": item["height"], "imageFormat": fmt.lower(),
            "imageFrames": count, "imageResized": item["resized"], "imageQuality": item["quality"],
            "imageOriginalWidth": original_sizes[0][0], "imageOriginalHeight": original_sizes[0][1],
            "width": item["width"], "height": item["height"], "format": fmt.lower(),
            "frames": count, "resized": item["resized"], "quality": item["quality"],
            "sourceWidth": original_sizes[0][0], "sourceHeight": original_sizes[0][1],
            "sourceFormat": item.get("source_format", "").lower(),
            "transparencyPreserved": alpha, "metadataRemoved": not original,
            "compressionMethod": "original" if original else "image-target", "attempts": attempts,
            "resultMessage": message}
