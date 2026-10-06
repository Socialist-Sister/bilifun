"""Verify ZIP contents and checksums without extracting or executing packaged files."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts"
version = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
assert package["version"] == lock["version"] == lock["packages"][""]["version"] == version
assert package["devDependencies"] == lock["packages"][""]["devDependencies"]
assert package["devDependencies"]["mediabunny"] == "1.61.0"
vendor_bytes = (ROOT / "extension" / "vendor-mediabunny.js").read_bytes()
vendor_digest = hashlib.sha256(vendor_bytes).hexdigest()
notice = (ROOT / "extension" / "third-party.html").read_text(encoding="utf-8")
assert vendor_digest in notice
assert "Mozilla Public License Version 2.0" in notice
assert "https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz" in notice
for name, metadata in lock["packages"].items():
    if name and metadata.get("resolved", "").startswith("https://registry."):
        assert metadata["resolved"].endswith(f'-{metadata["version"]}.tgz'), name
vendor = json.loads((ROOT / "extension" / "ffmpeg-vendor.json").read_text(encoding="utf-8"))
for name, digest in vendor["sha256"].items():
    assert hashlib.sha256((ROOT / "extension" / name).read_bytes()).hexdigest() == digest
for name, digest in vendor["sources"].items():
    assert hashlib.sha256((ROOT / "third-party" / "ffmpeg" / name).read_bytes()).hexdigest() == digest
assert (ROOT / "extension" / "ffmpeg-core.wasm").read_bytes()[:8] == b'\x00asm\x01\x00\x00\x00'
checksums = {name: digest for digest, name in (line.split() for line in (OUTPUT / "SHA256SUMS").read_text().splitlines())}
summary = {}
for suffix in ["", "-source"]:
    filename = f"bilifun-{version}{suffix}.zip"
    assert hashlib.sha256((OUTPUT / filename).read_bytes()).hexdigest() == checksums[filename]
    with zipfile.ZipFile(OUTPUT / filename) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert len(names) == len(set(names))
        for name in names:
            parts = PurePosixPath(name).parts
            assert not name.startswith("/") and ".." not in parts
            assert not any(part in {"node_modules", "artifacts", "__pycache__"} for part in parts)
            assert name.split("/")[-1] not in {"config.json", "launcher.cmd", "com.bilisearchlens.helper.json"}
            assert not name.lower().endswith((".exe", ".dll"))
            if name.endswith(".wasm"): assert name.split("/")[-1] == "ffmpeg-core.wasm"
            assert "native" not in parts and name.split("/")[-1] not in {"helper.html", "native-client.js"}
        prefix = "extension/" if suffix else ""
        manifest = json.loads(archive.read(prefix + "manifest.json"))
        assert manifest["version"] == version
        assert "nativeMessaging" not in manifest["optional_permissions"] + manifest["permissions"]
        assert "'wasm-unsafe-eval'" in manifest["content_security_policy"]["extension_pages"]
        runtime_files = {file.name for file in (ROOT / "extension").iterdir() if file.suffix in {".js", ".json", ".html", ".css", ".wasm"}}
        for name in runtime_files:
            assert archive.read(prefix + name) == (ROOT / "extension" / name).read_bytes()
        if not suffix:
            assert set(names) == runtime_files
        else:
            for required in ["README.md", "TODO.md", "CAPABILITIES.md", "PRIVACY.md", "VERIFICATION.md", "LICENSE", ".prettierignore", "scripts/vendor-mediabunny.cjs", "scripts/build-ffmpeg.sh", "extension/third-party.html", "third-party/ffmpeg/README.md", "third-party/ffmpeg/ffmpeg-5.1.8.tar.xz", "third-party/ffmpeg/bindings-0.12.10.tar.gz", "third-party/ffmpeg/lame-source.tar.gz", "tests/fixtures/README.md", "tests/fixtures/video.m4s", "tests/fixtures/audio.m4s"]:
                assert required in names
        summary[filename] = {"files": len(names), "bytes": (OUTPUT / filename).stat().st_size, "verified": True}
print(json.dumps(summary, indent=2))
