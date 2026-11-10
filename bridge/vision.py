"""Read one incoming image from the selected WeChat account's local cache.

This adapter intentionally never opens a WeChat window, fetches a URL, scans
process memory, or searches another conversation for a usable media key.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import time
import warnings

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 24_000_000
V1_MAGIC = b'\x07\x08\x05\x56\x02\x05'
V2_MAGIC = b'\x07\x08\x56\x32\x08\x07'
FORMATS = {'JPEG': ('image/jpeg', '.jpg'), 'PNG': ('image/png', '.png'),
           'WEBP': ('image/webp', '.webp'), 'BMP': ('image/png', '.png')}


class ImageUnavailable(Exception):
    """A user-safe reason that contains no paths, keys, or decrypted metadata."""

    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable is True


def _is_image_type(value):
    """Match the pinned client's image classification, including 4.x wrappers."""
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return False
    if value == 3:
        return True
    if value <= 0xFFFF:
        return False
    base = value & 0xFFFFFFFF
    # The dependency treats low-32-bit type 3 as an image and, for otherwise
    # unknown wrapped base types, can use their low byte. Do not query by an
    # assumed literal local_type=3: doing that drops the exact compound row.
    return base == 3 or (base & 0xFF) == 3


def _inside(path, root):
    path, root = Path(path).absolute(), Path(root).resolve()
    # Reject junctions/symlinks even when they point to another valid chat
    # inside the same account: a current-message filename must stay itself.
    current = path
    while current != root and current != current.parent:
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            raise ImageUnavailable('图片缓存路径含重定向，未读取其他附件')
        current = current.parent
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ImageUnavailable('图片缓存路径不属于当前聊天，未读取')
    return resolved


def _bounded_read(path, root, limit=MAX_IMAGE_BYTES + 65536):
    path = _inside(path, root)
    if not path.is_file():
        raise ImageUnavailable('本地图片尚未下载', retryable=True)
    if path.stat().st_size > limit:
        raise ImageUnavailable('本地图片超过10MB')
    with path.open('rb') as handle:
        data = handle.read(limit + 1)
    if not data:
        raise ImageUnavailable('本地图片为空、尚未下载完整', retryable=True)
    if len(data) > limit:
        raise ImageUnavailable('本地图片超过10MB')
    return data


def _image_hash(row):
    # Prefer an explicit img md5 in XML, then the pinned client's packed field.
    for field in ('content', 'packed_info'):
        blob = row.get(field)
        if isinstance(blob, str):
            blob = blob.encode('utf-8')
        if not isinstance(blob, bytes) or len(blob) > 262144:
            continue
        found = re.search(rb'\bmd5\s*=\s*[\"\x27]([0-9a-fA-F]{32})[\"\x27]', blob)
        if found:
            return found.group(1).decode('ascii').lower()
    blob = row.get('packed_info')
    if isinstance(blob, str):
        blob = blob.encode('utf-8')
    if isinstance(blob, bytes) and len(blob) <= 262144:
        found = re.search(rb'(?<![0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])', blob)
        if found:
            return found.group(1).decode('ascii').lower()
    return None


def _months(created):
    try:
        stamp = float(created)
        if not math.isfinite(stamp) or stamp <= 0:
            raise ValueError()
        when = datetime.fromtimestamp(stamp)
    except (ValueError, TypeError, OverflowError, OSError):
        raise ImageUnavailable('图片消息缺少可靠时间，未猜测附件位置')
    # Cache/month boundaries can differ around midnight; three exact filenames
    # in three month directories are bounded and never recurse through history.
    return list(dict.fromkeys((when.strftime('%Y-%m'),
                              (when - timedelta(days=1)).strftime('%Y-%m'),
                              (when + timedelta(days=1)).strftime('%Y-%m'))))


def _candidates(db, chat_id, raw, digest):
    account_root = Path(db.account_dir).resolve()
    base = _inside(account_root / 'msg' / 'attach' / hashlib.md5(chat_id.encode()).hexdigest(),
                   account_root)
    found = []
    for suffix, source in (('_h.dat', 'original'), ('.dat', 'compressed'),
                           ('_t.dat', 'thumbnail')):
        for month in _months(raw.get('create_time')):
            path = base / month / 'Img' / (digest + suffix)
            if path.exists():
                path = _inside(path, base)
                if path.is_file():
                    found.append((path, source))
    return base, found


def _key_candidates(db):
    """Only consume cfg already bound by the bridge, or this account's cache."""
    keys = []
    cfg = getattr(db, 'cfg_dword', None)
    if isinstance(cfg, int) and not isinstance(cfg, bool) and 0 < cfg <= 0xFFFFFFFF:
        key = hashlib.md5((str(cfg) + db.wxid).encode()).hexdigest()[:16]
        keys.append((key, cfg & 0xFF))
    workdir = Path(db.workdir).resolve()
    saved = workdir / 'image_keys.json'
    try:
        if saved.exists():
            cache = json.loads(_bounded_read(saved, workdir, 65536).decode('utf-8'))
            key = cache.get(db.account) if isinstance(cache, dict) else None
            if isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9]{16}', key):
                if not any(item[0] == key for item in keys):
                    keys.append((key, None))
    except (OSError, ValueError, ImageUnavailable):
        pass
    return keys


def _xor_hints(data, candidates, root):
    hints = []
    # The same message's thumbnail is the only fallback template allowed.
    for path, source in candidates:
        if source != 'thumbnail':
            continue
        try:
            thumb = _bounded_read(path, root)
            key = thumb[-2] ^ 0xFF
            if len(thumb) >= 2 and thumb[-1] ^ key == 0xD9:
                hints.append(key)
        except (OSError, ImageUnavailable, IndexError):
            pass
    # The known legacy defaults are validated by fully decoding the image.
    return list(dict.fromkeys(hints + [0x88, 0x30, 0xFF, 0xE9]))


def _decrypt(data, db, candidates, root):
    if data.startswith((b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'RIFF', b'BM', b'wxgf')):
        return [data]
    hints = _xor_hints(data, candidates, root)
    if data.startswith(V2_MAGIC):
        if len(data) < 31:
            raise ImageUnavailable('图片缓存尚未下载完整', retryable=True)
        aes_size, xor_size = struct.unpack_from('<LL', data, 6)
        aes_block = aes_size + 16 - aes_size % 16
        if aes_size > MAX_IMAGE_BYTES or xor_size > MAX_IMAGE_BYTES:
            raise ImageUnavailable('图片缓存声明大小超过10MB或已损坏')
        if 15 + aes_block + xor_size > len(data):
            raise ImageUnavailable('图片缓存尚未下载完整', retryable=True)
        keys = _key_candidates(db)
        if not keys:
            raise ImageUnavailable('当前账号的图片解码密钥尚不可用，请在微信打开原图后再发一次', retryable=True)
        # Use only the low-level, pure byte decoder from our pinned dependency.
        # Passing BOTH keys bypasses all account-wide key scans and templates.
        from wechatauto.media import MediaDownloader
        decoder = MediaDownloader(db)
        values = []
        for key, xor in keys:
            for hint in ([xor] if xor is not None else hints):
                try:
                    values.append(decoder._decrypt_v2(data, '', key, hint))
                except (ValueError, TypeError, IndexError, struct.error):
                    continue
        return values
    if data.startswith(V1_MAGIC):
        if len(data) <= 22:
            raise ImageUnavailable('图片缓存尚未下载完整', retryable=True)
        cfg = getattr(db, 'cfg_dword', None)
        if isinstance(cfg, int) and cfg > 0:
            hints.insert(0, cfg & 0xFF)
        return [bytes(byte ^ key for byte in data[22:]) for key in dict.fromkeys(hints)]
    return [bytes(byte ^ key for byte in data) for key in hints]


def _wxgf_image(data):
    """Convert the current message's WXGF/HEVC bytes, never access WeChat UI.

    The pinned library confirms ordinary WeChat 4.x pictures use this format,
    not only stickers. Use its local executable resolver, without downloading
    software or invoking its media-key resolver, broad scans, or UI fallbacks.
    """
    if not data.startswith(b'wxgf'):
        return data
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageUnavailable('图片超过10MB，请缩小后重发')
    start = data.find(b'\x00\x00\x00\x01')
    if start < 4:
        raise ImageUnavailable('微信图片容器未下载完整，请打开原图后重发')
    from wechatauto.media import MediaDownloader
    executable = MediaDownloader._ffmpeg_exe()
    if not executable:
        raise ImageUnavailable('本机缺少微信图片解码组件，请发PNG或JPEG截图')
    command = [executable, '-nostdin', '-hide_banner', '-loglevel', 'error',
               '-threads', '1', '-max_pixels', str(MAX_PIXELS), '-f', 'hevc',
               '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:v:0',
               '-frames:v', '1', '-an', '-sn', '-dn', '-threads', '1',
               '-vcodec', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1']
    try:
        result = subprocess.run(command, input=data[start:], capture_output=True,
                                timeout=8, check=False,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError):
        raise ImageUnavailable('微信图片容器解码未完成，请打开原图后重发')
    if result.returncode or not result.stdout.startswith(b'\xff\xd8\xff'):
        raise ImageUnavailable('微信图片容器无法解码，请打开原图后重发')
    if len(result.stdout) > MAX_IMAGE_BYTES:
        raise ImageUnavailable('图片转换后超过10MB，请缩小后重发')
    return result.stdout


def validate_image(data):
    """Fully verify actual bytes; filename or XML alone never establishes type."""
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ImageUnavailable('图片超过10MB或内容为空')
    from PIL import Image
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                fmt = image.format
                if fmt not in FORMATS or min(image.size) <= 0 or image.width * image.height > MAX_PIXELS:
                    raise ImageUnavailable('暂仅支持24MP以内的JPEG、PNG、WebP和BMP图片')
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                if getattr(image, 'is_animated', False):
                    raise ImageUnavailable('动态图暂不作为静态图片识别，请发截图')
                if fmt == 'BMP':
                    out = io.BytesIO()
                    image.convert('RGB').save(out, format='PNG')
                    data = out.getvalue()
                    if len(data) > MAX_IMAGE_BYTES:
                        raise ImageUnavailable('图片转换后超过10MB，请缩小后重发')
        mime, suffix = FORMATS[fmt]
        return data, mime, suffix
    except ImageUnavailable:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise ImageUnavailable('本地图片不完整或无法解码，请打开原图后重发')


def _write_image(data, suffix, output_dir, account_id, chat_id, row):
    root = Path(output_dir).resolve()
    folder = root / hashlib.sha256(account_id.encode()).hexdigest()[:16] / hashlib.sha256(chat_id.encode()).hexdigest()[:16]
    _inside(folder, root)
    folder.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256((str(row['shard']) + ':' + str(row['local_id'])).encode() + data).hexdigest()
    path = _inside(folder / (name + suffix), root)
    if not path.exists():
        temporary = _inside(folder / (name + '.tmp'), root)
        # Refuse a preexisting link before writing a temporary file as well.
        with temporary.open('wb') as handle:
            handle.write(data)
        os.replace(temporary, path)
    # Bounded cache: only this account/conversation's own old output files.
    for old in folder.iterdir():
        if old == path or not re.fullmatch(r'[0-9a-f]{64}\.(?:jpg|png|webp)', old.name):
            continue
        try:
            if _inside(old, folder).is_file() and time.time() - old.stat().st_mtime > 86400:
                old.unlink()
        except (OSError, ImageUnavailable):
            pass
    return str(path)


def receive_image(db, chat_id, row, output_dir, account_id=None):
    """Return one local attachment or an explicit, user-safe read failure.

    Call only after the bridge checks active account, selected chat and sender.
    The DB row is re-read using BOTH shard and local id to prevent collisions.
    """
    try:
        expected = account_id or getattr(db, 'wxid', '')
        if not expected or getattr(db, 'wxid', '') != expected:
            raise ImageUnavailable('图片所属账号与当前微信小号不一致')
        if not isinstance(chat_id, str) or not chat_id or len(chat_id) > 256:
            raise ImageUnavailable('图片所属聊天无效')
        local_id, shard = row.get('local_id'), row.get('shard')
        # Pinned WeChatDB labels decrypted message/message_N.db caches as
        # message__message_N.db; preserve that exact label for the DB lookup.
        # Only known basenames are accepted, never arbitrary filesystem paths.
        if not isinstance(local_id, int) or isinstance(local_id, bool) or local_id <= 0 or not isinstance(shard, str) or not re.fullmatch(r'(?:message__)?message_\d+\.db', shard):
            raise ImageUnavailable('图片消息缺少准确分片或消息编号，未读取其他图片')
        raw = db.get_message_row(chat_id, local_id, shard=shard)
        if not raw:
            raise ImageUnavailable('这条图片消息尚未写入本地缓存', retryable=True)
        if not _is_image_type(raw.get('local_type')) or raw.get('local_id') != local_id or raw.get('shard') != shard:
            raise ImageUnavailable('没有找到这条图片消息，未读取其他图片')
        if row.get('sender_username') and raw.get('sender_username') != row['sender_username']:
            raise ImageUnavailable('图片发送者核对不一致，未读取')
        digest = _image_hash(raw)
        if not digest:
            raise ImageUnavailable('图片消息缺少有效附件编号，未猜测其他图片', retryable=True)
        root, candidates = _candidates(db, chat_id, raw, digest)
        if not candidates:
            raise ImageUnavailable('这张图片尚未保存在本机，请在微信打开原图后重发', retryable=True)
        error = ImageUnavailable('本地图片不完整或无法解码，请打开原图后重发')
        for path, source in candidates:
            try:
                encrypted = _bounded_read(path, root)
                for value in _decrypt(encrypted, db, candidates, root):
                    try:
                        value = _wxgf_image(value)
                        data, mime, suffix = validate_image(value)
                        saved = _write_image(data, suffix, output_dir, expected, chat_id, raw)
                        return {'images': [{'path': saved, 'mimeType': mime, 'source': source}]}
                    except ImageUnavailable as exc:
                        error = exc
            except ImageUnavailable as exc:
                error = exc
            except OSError:
                error = ImageUnavailable('本地图片缓存暂时不可读，请稍后重发', retryable=True)
        raise error
    except ImageUnavailable as exc:
        return {'images': [], 'attachmentError': str(exc), 'attachmentRetryable': exc.retryable}
    except Exception:
        # No paths, key material, message XML or arbitrary library exceptions in
        # protocol events or prompts. Preserve a concrete honest failure state.
        return {'images': [], 'attachmentError': '这张图片读取失败，没有交给模型识别，请打开原图后重发', 'attachmentRetryable': False}
