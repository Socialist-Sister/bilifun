"""Deterministic ZIP packaging, standard library only. Never includes local configs/media."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/"extension"/"manifest.json").read_text(encoding="utf-8"))["version"]
OUTPUT=ROOT/"artifacts"
OUTPUT.mkdir(exist_ok=True)


def write_zip(destination, files):
    with zipfile.ZipFile(destination,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for filename,name in sorted(files,key=lambda pair:pair[1]):
            info=zipfile.ZipInfo(name,(1980,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.create_system=3
            info.external_attr=0o100644<<16
            archive.writestr(info,filename.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


runtime=[(file,file.name) for file in (ROOT/"extension").iterdir() if file.suffix in {".js",".json",".html",".css",".wasm"}]
source=[]
for folder in ["extension","tests","scripts",".github","third-party"]:
    for file in (ROOT/folder).rglob("*"):
        if file.is_file() and (file.suffix in {".js",".cjs",".ts",".json",".html",".css",".py",".md",".yml",".sh",".wasm",".xz",".gz",".txt"} or file.name == "COPYING") and "__pycache__" not in file.parts and file.name not in {"config.json","launcher.cmd","com.bilisearchlens.helper.json"}:
            source.append((file,file.relative_to(ROOT).as_posix()))
for filename in ["README.md","LICENSE","TODO.md","VERIFICATION.md","PRIVACY.md","CONTRIBUTING.md","CHANGELOG.md","ARCHITECTURE.md","CAPABILITIES.md","package.json","package-lock.json","tsconfig.json",".gitignore",".prettierignore"]:
    file=ROOT/filename
    if not file.exists():raise FileNotFoundError(f"Required release document missing: {filename}")
    source.append((file,filename))
for name in ["video.m4s","audio.m4s"]:
    file=ROOT/"tests"/"fixtures"/name
    source.append((file,file.relative_to(ROOT).as_posix()))
checksums={}
for label,files in [("",runtime),("-source",source)]:
    filename=f"bilifun-{VERSION}{label}.zip"
    checksums[filename]=write_zip(OUTPUT/filename,files)
(OUTPUT/"SHA256SUMS").write_text("".join(f"{digest}  {filename}\n" for filename,digest in checksums.items()),encoding="utf-8")
print(json.dumps(checksums,indent=2))
