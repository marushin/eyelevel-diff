"""배포용 zip 만들기. git이 관리하는 파일(무시 목록 제외)만 담는다.

    python scripts/pack.py            -> release/art-hackathon-local-YYYYMMDD.zip

Windows의 Compress-Archive는 실행 권한을 담지 못해 macOS에서 start.command를 더블클릭할 수 없다.
그래서 zip 항목을 Unix 형식으로 쓰고 실행 파일(.command, .sh)에 755 권한을 붙인다.
"""
import datetime
import pathlib
import subprocess
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXECUTABLE = ('.command', '.sh')


def files():
    out = subprocess.run(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout.decode('utf-8')
    return sorted(name for name in out.split('\0') if name and (ROOT / name).is_file())


def main():
    name = f'art-hackathon-local-{datetime.date.today():%Y%m%d}'
    target = ROOT / 'release' / f'{name}.zip'
    target.parent.mkdir(exist_ok=True)
    names = files()
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in names:
            path = ROOT / rel
            info = zipfile.ZipInfo(f'{name}/{rel}', date_time=datetime.datetime.fromtimestamp(path.stat().st_mtime).timetuple()[:6])
            info.create_system = 3  # Unix: macOS가 권한 비트를 읽게 한다
            mode = 0o755 if rel.endswith(EXECUTABLE) else 0o644
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            data = path.read_bytes()
            if rel.endswith(EXECUTABLE):
                data = data.replace(b'\r\n', b'\n')  # 셸 스크립트는 LF여야 돈다
            archive.writestr(info, data)
    print(f'{target}  ({len(names)} files, {target.stat().st_size / 1024 / 1024:.1f} MB)')


if __name__ == '__main__':
    main()
