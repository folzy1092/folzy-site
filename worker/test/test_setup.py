# -*- coding: utf-8 -*-
"""Помощники setup.py: правка .env, wrangler.toml, config.js и разбор вывода wrangler.
Запуск: python -m unittest discover -s test   (или pytest)."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import setup  # noqa: E402

ID = '0123456789abcdef0123456789abcdef'


def read(*parts):
    with open(os.path.join(HERE, '..', *parts), encoding='utf-8') as f:
        return f.read()


class EnvTest(unittest.TestCase):
    def test_merge_changes_only_given_keys_and_keeps_crlf(self):
        before = '# Музыка\r\nLASTFM_API_KEY="abc"\r\nSITE_NOW_URL=old\r\n\r\nGROQ_API=x\r\n'
        after = setup.merge_env(before, {'SITE_NOW_URL': 'https://w/now', 'SITE_PUSH_TOKEN': 'tok'})
        self.assertEqual(after, '# Музыка\r\nLASTFM_API_KEY="abc"\r\nSITE_NOW_URL=https://w/now\r\n\r\n'
                                'GROQ_API=x\r\nSITE_PUSH_TOKEN=tok\r\n')
        self.assertEqual(setup.parse_env(after), {'LASTFM_API_KEY': 'abc', 'SITE_NOW_URL': 'https://w/now',
                                                  'GROQ_API': 'x', 'SITE_PUSH_TOKEN': 'tok'})

    def test_merge_empty_and_export(self):
        self.assertEqual(setup.merge_env('', {'A': '1'}), 'A=1\n')
        self.assertEqual(setup.merge_env('export A=0\n', {'A': '1'}), 'A=1\n')

    def test_parse_skips_comments_and_quotes(self):
        self.assertEqual(setup.parse_env("# x=1\nA='q'\nB = 2\n"), {'A': 'q', 'B': '2'})


class TomlTest(unittest.TestCase):
    def test_kv_id_replaces_commented_block_and_round_trips(self):
        toml = read('wrangler.toml')
        self.assertIsNone(setup.kv_id_from_toml(toml))
        filled = setup.set_kv_id(toml, ID)
        self.assertEqual(setup.kv_id_from_toml(filled), ID)
        self.assertEqual(setup.kv_id_from_toml(setup.set_kv_id(filled, 'b' * 32)), 'b' * 32)
        self.assertIn('[[durable_objects.bindings]]', filled)
        self.assertIn('Europe/Moscow', filled)


class WranglerOutputTest(unittest.TestCase):
    def test_kv_id_toml_and_json(self):
        self.assertEqual(setup.kv_id_from_output(f'[[kv_namespaces]]\nbinding = "CACHE"\nid = "{ID}"'), ID)
        self.assertEqual(setup.kv_id_from_output(f'{{ "binding": "CACHE", "id": "{ID}" }}'), ID)

    def test_kv_id_from_list(self):
        out = f'⛅️ wrangler\n[{{"id": "x", "title": "other"}}, {{"id": "{ID}", "title": "folzy-music-cache"}}]'
        self.assertEqual(setup.kv_id_from_list(out), ID)
        self.assertIsNone(setup.kv_id_from_list('no json here'))

    def test_workers_url(self):
        out = 'Deployed folzy-music triggers\n  https://folzy-music.denis-v.workers.dev\nCurrent Version'
        self.assertEqual(setup.workers_url(out), 'https://folzy-music.denis-v.workers.dev')


class ConfigTest(unittest.TestCase):
    def test_endpoint_is_set(self):
        cfg = read('..', 'assets', 'js', 'config.js')
        new = setup.set_endpoint(cfg, 'https://folzy-music.x.workers.dev')
        self.assertIn("musicEndpoint: 'https://folzy-music.x.workers.dev'", new)
        self.assertEqual(len(new.splitlines()), len(cfg.splitlines()))


if __name__ == '__main__':
    unittest.main()
