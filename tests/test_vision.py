"""Synthetic local media fixtures. Never reads a live WeChat account or sends."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

spec = importlib.util.spec_from_file_location('koko_vision', Path(__file__).parents[1] / 'bridge/vision.py')
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)


def fixture(fmt='PNG', size=(24, 18)):
    value = io.BytesIO()
    Image.new('RGB', size, '#228855').save(value, format=fmt)
    return value.getvalue()


class VisionTests(unittest.TestCase):
    def setUp(self):
        temp_root = Path(__file__).parents[3] / 'work/koko-vision-test'
        temp_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.base = Path(self.temp.name)
        self.chat = 'selected-chat'
        self.digest = '0123456789abcdef0123456789abcdef'
        self.row = {'local_id': 7, 'shard': 'message_1.db', 'sender_username': 'friend'}
        self.raw = {**self.row, 'local_type': 3, 'create_time': time.time(),
                    'content': '<msg><img md5="' + self.digest + '"/></msg>'}
        self.calls = []

        def get_row(chat, local_id, **kwargs):
            self.calls.append((chat, local_id, kwargs))
            return self.raw

        self.db = SimpleNamespace(wxid='selected-account', account='selected-account_abcd',
                                  account_dir=str(self.base / 'wechat-account'),
                                  workdir=str(self.base / 'account-private-cache'),
                                  cfg_dword=None, get_message_row=get_row)
        self.output = self.base / 'model-images'
        self.image_dir = (Path(self.db.account_dir) / 'msg/attach' /
                          hashlib.md5(self.chat.encode()).hexdigest() /
                          time.strftime('%Y-%m') / 'Img')
        self.image_dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def put(self, data=None, tier='compressed', directory=None):
        suffix = {'original': '_h.dat', 'compressed': '.dat', 'thumbnail': '_t.dat'}[tier]
        path = (directory or self.image_dir) / (self.digest + suffix)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if data is not None else fixture())
        return path

    def receive(self, **kwargs):
        return vision.receive_image(self.db, self.chat, self.row, self.output,
                                    account_id=kwargs.get('account_id', 'selected-account'))

    def test_exact_db_row_and_validated_attachment(self):
        self.put()
        result = self.receive()
        image = result['images'][0]
        self.assertEqual(image['source'], 'compressed')
        self.assertEqual(image['mimeType'], 'image/png')
        self.assertTrue(Path(image['path']).is_absolute())
        self.assertTrue(Path(image['path']).is_relative_to(self.output))
        self.assertEqual(Path(image['path']).read_bytes(), fixture())
        self.assertEqual(self.calls, [(self.chat, 7, {'shard': 'message_1.db'})])

    def test_pinned_client_decrypted_shard_label_reads_exact_image(self):
        from wechatauto.db import WeChatDB
        path = self.base / 'message__message_1.db'
        conn = sqlite3.connect(path)
        try:
            label = WeChatDB._shard_label(None, conn)
        finally:
            conn.close()
        self.assertEqual(label, 'message__message_1.db')
        self.row['shard'] = self.raw['shard'] = label
        self.put()
        result = self.receive()
        self.assertTrue(result['images'], result.get('attachmentError'))
        self.assertEqual(self.calls, [(self.chat, 7, {'shard': label})])

    def test_real_client_reads_compound_image_without_literal_type_filter(self):
        from wechatauto.db import WeChatDB
        path = self.base / 'message__message_2.db'
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('CREATE TABLE Name2Id (user_name TEXT)')
            conn.execute('INSERT INTO Name2Id VALUES (?)', ('friend',))
            conn.execute('CREATE TABLE Msg_fixture (local_id INTEGER, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content BLOB, source BLOB, packed_info_data BLOB, compress_content BLOB, server_id INTEGER, sort_seq INTEGER)')
            kind = (17 << 32) | 3
            conn.execute('INSERT INTO Msg_fixture VALUES (?,?,?,?,?,?,?,?,?,?)', (7, kind, 1, int(time.time()), self.raw['content'], None, None, None, 99, 100))
            conn.commit()
            client = WeChatDB.__new__(WeChatDB)
            client.account = self.db.account
            client.account_dir = self.db.account_dir
            client.workdir = self.db.workdir
            client.cfg_dword = None
            requested = []

            def run(user, build):
                requested.append(user)
                return build([(conn, 'Msg_fixture')])

            client._run_msg_query = run
            self.assertEqual(client._msg_type_name(kind), '图片')
            self.row['shard'] = client._shard_label(conn)
            self.put()
            out = vision.receive_image(client, self.chat, self.row, self.output, account_id=client.wxid)
            self.assertTrue(out['images'], out.get('attachmentError'))
            self.assertEqual(requested, [self.chat])
        finally:
            conn.close()

    def test_non_image_compound_types_still_rejected(self):
        self.put()
        for kind in ((57 << 32) | 49, (17 << 32) | 34, -3, True, '3', 259):
            with self.subTest(kind=kind):
                self.raw['local_type'] = kind
                self.assertFalse(self.receive()['images'])

    def test_only_known_shard_basenames_are_accepted(self):
        self.put()
        for value in ('../message__message_1.db', 'C:/cache/message__message_1.db',
                      'message__message_1.db/other', 'message__message_resource.db',
                      'message__message_1.db\n', 'contact.db'):
            with self.subTest(shard=value):
                self.row['shard'] = self.raw['shard'] = value
                self.assertFalse(self.receive()['images'])
        self.assertFalse(self.calls)

    def test_quality_tiers_prefer_original_then_compressed_then_thumbnail(self):
        original = self.put(tier='original')
        compressed = self.put(tier='compressed')
        self.put(tier='thumbnail')
        self.assertEqual(self.receive()['images'][0]['source'], 'original')
        original.unlink()
        self.assertEqual(self.receive()['images'][0]['source'], 'compressed')
        compressed.unlink()
        self.assertEqual(self.receive()['images'][0]['source'], 'thumbnail')

    def test_broken_original_falls_back_without_claiming_original(self):
        self.put(b'broken', 'original')
        self.put(tier='thumbnail')
        self.assertEqual(self.receive()['images'][0]['source'], 'thumbnail')

    def test_never_falls_back_to_another_chat_or_hash(self):
        other = Path(self.db.account_dir) / 'msg/attach/other-chat' / time.strftime('%Y-%m') / 'Img'
        self.put(directory=other)
        (self.image_dir / ('f' * 32 + '.dat')).write_bytes(fixture())
        result = self.receive()
        self.assertFalse(result['images'])
        self.assertIn('尚未保存在本机', result['attachmentError'])

    def test_missing_shard_never_queries_or_guesses(self):
        self.row.pop('shard')
        self.put()
        self.assertFalse(self.receive()['images'])
        self.assertFalse(self.calls)

    def test_row_collision_wrong_sender_wrong_account_and_wrong_type_rejected(self):
        self.put()
        self.assertFalse(self.receive(account_id='different-account')['images'])
        self.assertFalse(self.calls)
        for field, bad in [('local_id', 8), ('shard', 'message_2.db'),
                           ('sender_username', 'stranger'), ('local_type', 1)]:
            original = self.raw[field]
            self.raw[field] = bad
            self.assertFalse(self.receive()['images'])
            self.raw[field] = original

    def test_arbitrary_message_path_is_not_used(self):
        elsewhere = self.base / 'unrelated.png'
        elsewhere.write_bytes(fixture())
        self.raw['content'] = str(elsewhere)
        self.raw['packed_info'] = b''
        self.assertFalse(self.receive()['images'])

    def test_oversized_cache_rejected_before_decrypt(self):
        path = self.put()
        with path.open('wb') as handle:
            handle.truncate(vision.MAX_IMAGE_BYTES + 65537)
        result = self.receive()
        self.assertFalse(result['images'])
        self.assertIn('超过10MB', result['attachmentError'])

    def test_bmp_converted_and_gif_or_invalid_payload_rejected(self):
        self.put(fixture('BMP'))
        image = self.receive()['images'][0]
        self.assertEqual(image['mimeType'], 'image/png')
        self.assertTrue(Path(image['path']).read_bytes().startswith(b'\x89PNG'))
        self.put(fixture('GIF'))
        self.assertFalse(self.receive()['images'])
        self.put(b'<html>not an image</html>')
        self.assertFalse(self.receive()['images'])

    def test_pixel_limit_is_checked_before_decoding_all_pixels(self):
        self.put(fixture(size=(20, 20)))
        with patch.object(vision, 'MAX_PIXELS', 300):
            result = self.receive()
        self.assertFalse(result['images'])
        self.assertIn('24MP', result['attachmentError'])

    def test_legacy_xor_uses_only_current_message(self):
        data = fixture('JPEG')
        self.put(bytes(x ^ 0x88 for x in data))
        result = self.receive()
        self.assertEqual(Path(result['images'][0]['path']).read_bytes(), data)

    def test_v2_uses_explicit_cfg_no_default_media_scan(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from wechatauto.media import MediaDownloader
        self.db.cfg_dword = 100123
        key, xor = MediaDownloader.derive_image_keys(self.db.cfg_dword, self.db.wxid)
        data = fixture('JPEG')
        head = data[:32]
        pad = 16 - len(head) % 16
        encryptor = Cipher(algorithms.AES(key.encode()), modes.ECB()).encryptor()
        cipher = encryptor.update(head + bytes([pad]) * pad) + encryptor.finalize()
        tail = data[-32:]
        wrapped = vision.V2_MAGIC + struct.pack('<LLB', len(head), len(tail), 0) + cipher + data[32:-32] + bytes(x ^ xor for x in tail)
        self.put(wrapped)
        with patch.object(MediaDownloader, '_scan_aes_key', side_effect=AssertionError('memory scan')), \
                patch.object(MediaDownloader, '_collect_templates', side_effect=AssertionError('other chat scan')), \
                patch.object(MediaDownloader, '_resolve_aes_key', side_effect=AssertionError('key resolver')):
            result = self.receive()
        self.assertEqual(Path(result['images'][0]['path']).read_bytes(), data)

    def test_real_wxgf_hevc_picture_converts_without_touching_key_scans(self):
        from wechatauto.media import MediaDownloader
        executable = MediaDownloader._ffmpeg_exe()
        if not executable:
            self.skipTest('Local FFmpeg is unavailable')
        # A genuine HEVC frame, produced from a synthetic solid-colour source.
        encoded = subprocess.run([executable, '-nostdin', '-hide_banner', '-loglevel', 'error',
                                  '-f', 'lavfi', '-i', 'color=c=green:s=32x24:d=0.04',
                                  '-frames:v', '1', '-c:v', 'libx265', '-threads', '1',
                                  '-x265-params', 'pools=1:frame-threads=1:log-level=error',
                                  '-f', 'hevc', 'pipe:1'], capture_output=True, timeout=8,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(encoded.returncode, 0)
        self.assertTrue(encoded.stdout)
        self.put(b'wxgf' + b'\x00' * 12 + encoded.stdout)
        with patch.object(MediaDownloader, '_scan_aes_key', side_effect=AssertionError('memory scan')), \
                patch.object(MediaDownloader, '_collect_templates', side_effect=AssertionError('other chat scan')):
            result = self.receive()
        self.assertTrue(result['images'], result.get('attachmentError'))
        self.assertEqual(result['images'][0]['mimeType'], 'image/jpeg')
        self.assertEqual(result['images'][0]['source'], 'compressed')
        with Image.open(result['images'][0]['path']) as image:
            self.assertEqual(image.size, (32, 24))
            r, g, b = image.getpixel((16, 12))
            self.assertGreater(g, r + 60)
            self.assertGreater(g, b + 60)
        # The codec must reject oversized decoded dimensions before providing
        # an output to PIL; a tiny input cannot bypass the model image limit.
        with patch.object(vision, 'MAX_PIXELS', 300):
            limited = self.receive()
        self.assertFalse(limited['images'])

    def test_pinned_type_classifier_and_helper_agree_on_wrapped_images(self):
        from wechatauto.db import WeChatDB
        for value in (3, (17 << 32) | 3, (17 << 32) | 259):
            with self.subTest(value=value):
                self.assertEqual(WeChatDB._msg_type_name(value), '图片')
                self.assertTrue(vision._is_image_type(value))

    def test_wxgf_decode_failure_or_unavailable_component_keeps_same_message_thumbnail(self):
        from wechatauto.media import MediaDownloader
        wrapped = b'wxgf' + b'\x00' * 12 + b'\x00\x00\x00\x01' + b'not-hevc'
        self.put(wrapped)
        self.put(fixture('JPEG'), 'thumbnail')
        with patch.object(MediaDownloader, '_ffmpeg_exe', return_value=None):
            out = self.receive()
        self.assertEqual(out['images'][0]['source'], 'thumbnail')
        with patch.object(vision.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ffmpeg', 8)):
            out = self.receive()
        self.assertEqual(out['images'][0]['source'], 'thumbnail')

    def test_wxgf_error_does_not_leak_codec_stderr_or_paths(self):
        wrapped = b'wxgf' + b'\x00' * 12 + b'\x00\x00\x00\x01' + b'not-hevc'
        self.put(wrapped)
        failed = subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'SECRET_KEY C:/private')
        with patch.object(vision.subprocess, 'run', return_value=failed):
            out = self.receive()
        self.assertFalse(out['images'])
        self.assertNotIn('SECRET', str(out))
        self.assertNotIn('C:/', str(out))
        self.assertIn('无法解码', out['attachmentError'])

    def test_missing_v2_key_returns_explicit_failure_without_scan(self):
        self.put(vision.V2_MAGIC + struct.pack('<LLB', 16, 0, 0) + b'a' * 32)
        result = self.receive()
        self.assertFalse(result['images'])
        self.assertIn('解码密钥尚不可用', result['attachmentError'])

    def test_only_current_account_cached_key_selected(self):
        cache = Path(self.db.workdir)
        cache.mkdir()
        (cache / 'image_keys.json').write_text(json.dumps({'other': 'b' * 16, self.db.account: 'a' * 16}))
        self.assertEqual(vision._key_candidates(self.db), [('a' * 16, None)])

    def test_failures_do_not_reveal_paths_or_library_exception_text(self):
        self.db.get_message_row = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('SECRET_KEY C:/private'))
        result = self.receive()
        self.assertNotIn('SECRET', str(result))
        self.assertNotIn('C:/', str(result))
        self.assertIn('读取失败', result['attachmentError'])

    def test_retry_flag_distinguishes_pending_current_attachment_from_permanent_rejection(self):
        self.assertTrue(self.receive()['attachmentRetryable'])
        self.db.get_message_row = lambda *args, **kwargs: None
        self.assertTrue(self.receive()['attachmentRetryable'])
        self.db.get_message_row = lambda *args, **kwargs: self.raw
        self.raw['packed_info'] = b''
        content = self.raw['content']
        self.raw['content'] = ''
        self.assertTrue(self.receive()['attachmentRetryable'])
        self.raw['content'] = content
        self.put(b'')
        self.assertTrue(self.receive()['attachmentRetryable'])
        self.put(vision.V2_MAGIC + b'partial')
        self.assertTrue(self.receive()['attachmentRetryable'])
        self.assertFalse(self.receive(account_id='another-account')['attachmentRetryable'])
        self.raw['sender_username'] = 'unrelated-sender'
        self.assertFalse(self.receive()['attachmentRetryable'])

    def test_redirected_current_message_file_never_reads_another_image(self):
        target = self.image_dir / ('f' * 32 + '.dat')
        target.write_bytes(fixture())
        try:
            os.symlink(target, self.image_dir / (self.digest + '.dat'))
        except OSError:
            self.skipTest('Windows symlink privilege is unavailable')
        result = self.receive()
        self.assertFalse(result['images'])
        self.assertIn('重定向', result['attachmentError'])

    def test_packed_info_hash_is_supported_but_malformed_v2_is_not(self):
        self.raw['content'] = ''
        self.raw['packed_info'] = b'\x01\x02' + self.digest.encode() + b'\x00'
        self.put()
        self.assertTrue(self.receive()['images'])
        self.put(vision.V2_MAGIC + struct.pack('<LLB', 0xFFFFFFFF, 0xFFFFFFFF, 0) + b'a' * 32)
        result = self.receive()
        self.assertFalse(result['images'])
        self.assertIn('已损坏', result['attachmentError'])
        self.assertFalse(result['attachmentRetryable'])


if __name__ == '__main__':
    unittest.main()
