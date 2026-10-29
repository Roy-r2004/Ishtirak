"""Package source and final evidence, excluding local environments and credentials."""
from pathlib import Path
import os
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'Ishtirak_Submission.zip'
selected = []
for name in ('README.md', 'Dockerfile', 'compose.yaml', 'go.mod', 'go.sum', '.dockerignore', '.gitignore',
             'Final-Project 2025.pdf', 'Ishtirak_Project_Proposal_slim.docx', 'Ishtirak_Project_Flow.drawio'):
    selected.append(ROOT / name)
for directory in ('cmd', 'internal', 'web', 'deploy', 'scripts', 'docs'):
    for current, dirs, files in os.walk(ROOT / directory, followlinks=False):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '__pycache__', '.git')
                   and not (Path(current) / d).is_symlink()
                   and not os.path.isjunction(Path(current) / d)]
        for name in files:
            file = Path(current) / name
            if name.startswith('.env') or name.endswith(('.tsbuildinfo', '.log', '.inspect.ndjson', '.pyc')):
                continue
            if file.is_symlink() or not file.resolve().is_relative_to(ROOT):
                raise RuntimeError('Refusing nonlocal source path')
            selected.append(file)
for name in ('evaluation.json', 'chaos-check.json', 'browser-check.json', 'dashboard-desktop.png', 'dashboard-lab-desktop.png',
             'dashboard-lab-after-failover.png', 'dashboard-mobile.png', 'verification.txt'):
    selected.append(ROOT / 'artifacts' / name)
secret_pattern = re.compile(rb'(?:apikey_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{30,})')
for file in selected:
    if not file.is_file():
        raise RuntimeError('Required submission file missing: ' + str(file.relative_to(ROOT)))
    if secret_pattern.search(file.read_bytes()):
        raise RuntimeError('Credential-like content detected; refusing package')
with zipfile.ZipFile(OUTPUT, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for file in sorted(set(selected)):
        bundle.write(file, 'Ishtirak/' + file.relative_to(ROOT).as_posix())
with zipfile.ZipFile(OUTPUT) as bundle:
    if bundle.testzip() is not None:
        raise RuntimeError('Archive CRC validation failed')
    print(f'{OUTPUT}: {len(bundle.namelist())} files, {OUTPUT.stat().st_size:,} bytes; CRC validation passed')
