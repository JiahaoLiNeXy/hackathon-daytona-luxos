"""Package only the portable handoff allowlist. Run after npm run verify."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
if not (root / 'dist/index.html').is_file():
    raise SystemExit('Missing dist/. Run npm run verify first.')
files = []
for directory in ('src', 'server', 'public', 'dist', 'docs', 'examples', 'references', 'scripts', 'tests'):
    files.extend(p for p in (root / directory).rglob('*') if p.is_file() and p.name != '.DS_Store' and '__pycache__' not in p.parts)
files.extend(root / name for name in ('README.md', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js'))
manifest = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
desktop_overlay = root / 'overlay/overlay.py'
if not desktop_overlay.is_file():
    desktop_overlay = root.parents[1] / 'overlay/overlay.py'
if not desktop_overlay.is_file():
    raise SystemExit('Missing desktop overlay launcher.')
manifest['overlay/overlay.py'] = hashlib.sha256(desktop_overlay.read_bytes()).hexdigest()
output = root / 'artifacts/roadster-ui-handoff.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, str(path.relative_to(root)))
    archive.write(desktop_overlay, 'overlay/overlay.py')
    archive.writestr('SHA256SUMS.json', json.dumps(manifest, indent=2) + '\n')
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Archive validation failed')
print(f'{output.name}: {output.stat().st_size:,} bytes, {len(manifest)} files + manifest')
