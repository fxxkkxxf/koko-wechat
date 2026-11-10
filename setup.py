"""Install an isolated WeChat bridge, without changing the user's global Python."""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir')
    parser.add_argument('--python', help='Reuse an already prepared bridge Python executable')
    args = parser.parse_args()
    state = Path(args.data_dir).resolve() if args.data_dir else Path.home() / '.koko-wechat'
    state.mkdir(parents=True, exist_ok=True)
    interpreter = Path(args.python).resolve() if args.python else state / 'runtime/venv/Scripts/python.exe'
    if not args.python:
        subprocess.run([sys.executable, '-m', 'venv', str(interpreter.parent.parent)], check=True)
        env = dict(os.environ)
        for key in list(env):
            if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy') and env[key].rstrip('/') in ('http://127.0.0.1:9', 'http://localhost:9'):
                env.pop(key)
        subprocess.run([str(interpreter), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(ROOT/'bridge/requirements.txt')], check=True, env=env)
    subprocess.run([str(interpreter), '-c', 'import wechatauto, uiautomation, psutil, win32gui, imageio_ffmpeg; from PIL import Image'], check=True)
    runtime = {'python': str(interpreter), 'state_directory': str(state), 'port': 65470}
    (ROOT/'runtime.local.json').write_text(json.dumps(runtime, ensure_ascii=False, indent=2), encoding='utf-8')
    print('安装完成，请运行“打开可可微信助手.cmd”，自行选择小号和聊天对象。')

if __name__ == '__main__':
    main()
