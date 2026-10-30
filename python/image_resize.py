"""Fixed-dimension local image resizing with an optional maximum-size search.

Size searches only change encoding. They never secretly change requested pixels.
"""
import base64
from decimal import Decimal, ROUND_HALF_UP
import io
import math
import time

from PIL import Image, features

from image_compression import (
    EXTENSIONS, MEDIA, MAX_INPUT, MAX_PIXELS, MAX_TOTAL_PIXELS, MAX_ATTEMPTS,
    MAX_SECONDS, ImageCompressionError, _decode_file, _read_frames, _loss_score,
)

MAX_OUTPUT = 64 * 1024 * 1024


class ImageResizeError(ValueError):
    pass


def _number(value, label):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ImageResizeError(f"Enter a finite positive {label}.")
    return value


def _round(value):
    return int(Decimal(str(value)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def _dimensions(payload):
    unit = payload.get('unit', 'px')
    if unit not in ('px', 'cm'):
        raise ImageResizeError('Choose pixels (px) or centimetres (cm).')
    width, height = _number(payload.get('width'), 'width'), _number(payload.get('height'), 'height')
    dpi = _number(payload.get('dpi', 300), 'DPI')
    if not 36 <= dpi <= 1200:
        raise ImageResizeError('Choose a DPI between 36 and 1200.')
    aspect = payload.get('maintainAspectRatio', True)
    if type(aspect) is not bool:
        raise ImageResizeError('Maintain aspect ratio must be enabled or disabled.')
    if unit == 'px':
        if int(width) != width or int(height) != height:
            raise ImageResizeError('Pixel width and height must be whole numbers.')
        pixels = int(width), int(height)
    else:
        pixels = tuple(int((Decimal(str(value)) * Decimal(str(dpi)) / Decimal('2.54')).quantize(Decimal('1'), rounding=ROUND_HALF_UP)) for value in (width, height))
    if min(pixels) < 1 or max(pixels) > 30_000 or pixels[0] * pixels[1] > MAX_PIXELS:
        raise ImageResizeError('Choose output dimensions of at least one pixel, at most 30000 pixels per side and 50 million pixels per image.')
    return unit, width, height, dpi, aspect, pixels


def _encode(frames, fmt, quality, durations, animation, profile, dpi, lossless=False):
    output = io.BytesIO()
    options = {}
    if profile and fmt in {'JPEG', 'PNG', 'WEBP', 'AVIF', 'TIFF'}:
        options['icc_profile'] = profile
    if fmt in {'JPEG', 'PNG', 'TIFF'}:
        options['dpi'] = (dpi, dpi)
    elif fmt in {'WEBP', 'AVIF'}:
        # Generated resolution only; never copy source EXIF/GPS or orientation.
        exif = Image.Exif()
        exif[282], exif[283], exif[296] = dpi, dpi, 2
        options['exif'] = exif
    if fmt == 'JPEG':
        options.update(quality=quality, optimize=True, progressive=True, subsampling=0 if quality >= 85 else 2)
    elif fmt == 'PNG':
        options.update(optimize=True, compress_level=9)
    elif fmt == 'WEBP':
        options.update(quality=quality, method=5, lossless=lossless, exact=True)
    elif fmt == 'AVIF':
        large = frames[0].width * frames[0].height > 12_000_000
        options.update(quality=quality, speed=10 if large else 8, max_threads=2,
                       subsampling='4:4:4' if quality >= 85 else '4:2:0')
    elif fmt == 'TIFF':
        options['compression'] = 'tiff_adobe_deflate'
    if len(frames) > 1:
        options.update(save_all=True, append_images=frames[1:])
        if fmt != 'TIFF':
            poster = fmt == 'PNG' and animation['default_image']
            options['duration'] = durations[1:] if poster else durations
            if animation['loop'] is not None:
                options['loop'] = animation['loop']
            if poster:
                options['default_image'] = True
        if fmt == 'GIF':
            options.update(optimize=True, disposal=2)
    converted = frames[0].convert('RGB') if fmt == 'JPEG' and frames[0].mode != 'RGB' else None
    try:
        (converted or frames[0]).save(output, format=fmt, **options)
    finally:
        if converted is not None:
            converted.close()
    data = output.getvalue()
    if len(data) > MAX_OUTPUT:
        raise ImageResizeError('The resized image exceeds the 64 MiB output limit. Choose smaller dimensions or a more compact format.')
    with Image.open(io.BytesIO(data)) as check:
        for index, frame in enumerate(frames):
            check.seek(index)
            if check.size != frame.size:
                raise ValueError('The encoded image changed requested dimensions.')
        try:
            check.seek(len(frames))
            raise ValueError('The encoded image changed its frame count.')
        except EOFError:
            pass
    return data


def resize_image(payload):
    if not isinstance(payload, dict):
        raise ImageResizeError('Choose an image and output dimensions.')
    unit, width, height, dpi, aspect, box = _dimensions(payload)
    target = payload.get('targetBytes')
    if target is not None and (type(target) is not int or not 1000 <= target <= MAX_INPUT):
        raise ImageResizeError('Choose a target maximum from 1000 to 16777216 bytes, as a whole number.')
    selected = payload.get('outputFormat', 'auto')
    if selected not in ('auto', 'jpeg', 'png', 'webp', 'avif'):
        raise ImageResizeError('Choose automatic, JPEG, PNG, WebP or AVIF output.')
    try:
        raw = _decode_file(payload.get('file'))
        frames, durations, animation, original_format, profile, alpha = _read_frames(raw)
    except ImageCompressionError as error:
        raise ImageResizeError(str(error)) from None
    resized = []
    started, attempts = time.monotonic(), 0
    requested = None if selected == 'auto' else selected.upper()
    try:
        high_precision = any(frame.mode.startswith('I;16') for frame in frames)
        if high_precision and requested not in (None, 'PNG'):
            raise ImageResizeError('Choose Auto or PNG to retain 16-bit grayscale precision.')
        if alpha and requested == 'JPEG':
            raise ImageResizeError('JPEG cannot retain transparency. Choose Auto, PNG, WebP or AVIF.')
        if len(frames) > 1:
            if original_format == 'AVIF':
                raise ImageResizeError('Animated AVIF cannot be resized without risking its loop setting. Export GIF, APNG or WebP first.')
            if requested == 'JPEG' or requested == 'AVIF':
                raise ImageResizeError('Choose Auto to preserve every frame or page and its playback settings.')
            if original_format in {'TIFF', 'HEIF'} and requested is not None:
                raise ImageResizeError('Choose Auto to preserve every TIFF or HEIF page.')
            if original_format in {'GIF', 'PNG', 'WEBP'} and requested not in (None, original_format):
                raise ImageResizeError('Choose Auto or the source animation format to retain timing, looping and poster behavior.')
        if requested == 'WEBP' and not features.check('webp'):
            raise ImageResizeError('WebP encoding is unavailable in the local image engine.')
        if requested == 'AVIF' and not features.check('avif'):
            raise ImageResizeError('AVIF encoding is unavailable in the local image engine.')
        sizes = []
        for frame in frames:
            if aspect:
                scale = min(box[0] / frame.width, box[1] / frame.height)
                size = min(box[0], max(1, _round(frame.width * scale))), min(box[1], max(1, _round(frame.height * scale)))
            else:
                size = box
            sizes.append(size)
        if sum(w * h for w, h in sizes) > MAX_TOTAL_PIXELS:
            raise ImageResizeError('The resized frames exceed 60 million pixels combined. Choose smaller dimensions or fewer frames.')
        for frame, size in zip(frames, sizes):
            if frame.mode.startswith('I;16'):
                work = frame.convert('I')
                try:
                    resized.append(work.resize(size, Image.Resampling.LANCZOS).convert('I;16'))
                finally:
                    work.close()
            else:
                resized.append(frame.resize(size, Image.Resampling.LANCZOS))
        if requested:
            formats = [requested]
        elif high_precision:
            formats = ['TIFF'] if len(frames) > 1 else ['PNG']
        elif len(frames) > 1:
            formats = ['TIFF'] if original_format == 'HEIF' else [original_format]
        else:
            formats = ['PNG'] if resized[0].width * resized[0].height <= 12_000_000 or alpha else []
            if not alpha:
                formats.append('JPEG')
            if features.check('webp'):
                formats.append('WEBP')
            if features.check('avif'):
                formats.append('AVIF')
        if unit == 'cm' and formats == ['GIF']:
            raise ImageResizeError('GIF cannot store a reliable print DPI. Use pixel dimensions for this animation.')
        best, best_under = None, None

        def available():
            return attempts < MAX_ATTEMPTS and time.monotonic() - started < MAX_SECONDS

        def trial(fmt, quality=95, lossless=False):
            nonlocal attempts, best, best_under
            if not available():
                return None
            attempts += 1
            try:
                data = _encode(resized, fmt, quality, durations, animation, profile, dpi, lossless)
            except (OSError, ValueError, RuntimeError):
                return None
            candidate = {'bytes': data, 'format': fmt, 'quality': quality if fmt in {'JPEG', 'WEBP', 'AVIF'} and not lossless else None,
                         'lossless': lossless, 'score': 0 if lossless else _loss_score(resized[0], data)}
            if best is None or len(data) < len(best['bytes']):
                best = candidate
            if target is None or len(data) <= target:
                rank = (not lossless, candidate['score'], len(data))
                if best_under is None or rank < best_under['rank']:
                    candidate['rank'] = rank
                    best_under = candidate
            return candidate

        # Lossless encoding is preferred when it meets the requested maximum.
        for fmt in formats:
            if fmt in {'PNG', 'TIFF'}:
                trial(fmt, lossless=True)
            elif fmt == 'WEBP' and resized[0].width * resized[0].height <= 12_000_000:
                trial(fmt, lossless=True)
        if best_under is None:
            for fmt in formats:
                if not available():
                    break
                if fmt not in {'JPEG', 'WEBP', 'AVIF'}:
                    trial(fmt, lossless=fmt in {'PNG', 'TIFF'})
                    continue
                high = trial(fmt, 95)
                if target is None or (high and len(high['bytes']) <= target):
                    continue
                low = trial(fmt, 50)
                if low is None or len(low['bytes']) > target:
                    continue
                left, right = 51, 94
                while left <= right and available():
                    middle = (left + right) // 2
                    item = trial(fmt, middle)
                    if item is None or len(item['bytes']) > target:
                        right = middle - 1
                    else:
                        left = middle + 1
        chosen = best_under or best
        if chosen is None:
            raise ImageResizeError('The image could not be encoded within the local limits. Try a different format or smaller dimensions.')
        data, fmt = chosen['bytes'], chosen['format']
        reached = target is None or len(data) <= target
        changed = any(frame.size != size for frame, size in zip(frames, sizes))
        message = 'The image was resized with Lanczos resampling. '
        if target is not None:
            message += 'The target maximum was reached.' if reached else 'The target maximum could not be reached at the requested dimensions. Dimensions were retained and the smallest tested valid encoding was returned.'
        else:
            message += 'No maximum file size was requested.'
        if len(frames) > 1:
            message += f' All {len(frames)} frames or pages were retained.'
        if alpha:
            message += ' Transparency was retained.'
        output = {'data': base64.b64encode(data).decode('ascii'), 'name': f'localfold-resized.{EXTENSIONS.get(fmt, fmt.lower())}',
                  'mediaType': MEDIA.get(fmt, 'application/octet-stream'), 'pageCount': len(frames),
                  'inputBytes': len(raw), 'outputBytes': len(data), 'reduced': len(data) < len(raw), 'rasterized': False,
                  'imageWidth': sizes[0][0], 'imageHeight': sizes[0][1], 'imageFormat': fmt.lower(), 'imageFrames': len(frames),
                  'imageResized': changed, 'imageQuality': chosen['quality'], 'imageDpi': dpi if fmt != 'GIF' else None, 'dpi': dpi,
                  'imageDpiEmbedded': fmt in {'JPEG', 'PNG', 'TIFF', 'WEBP', 'AVIF'},
                  'width': sizes[0][0], 'height': sizes[0][1], 'format': fmt.lower(), 'frames': len(frames), 'resized': changed,
                  'quality': chosen['quality'], 'sourceWidth': frames[0].width, 'sourceHeight': frames[0].height,
                  'requestedWidth': width, 'requestedHeight': height, 'requestedUnit': unit, 'maintainAspectRatio': aspect,
                  'imageTargetEnabled': target is not None, 'compressionMethod': 'image-resize', 'attempts': attempts,
                  'metadataRemoved': True, 'transparencyPreserved': alpha, 'resultMessage': message}
        if target is not None:
            output.update(targetBytes=target, targetReached=reached)
        return output
    except ImageCompressionError as error:
        raise ImageResizeError(str(error)) from None
    finally:
        for frame in resized:
            frame.close()
        for frame in frames:
            frame.close()
