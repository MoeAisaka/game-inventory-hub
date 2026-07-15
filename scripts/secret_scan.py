#!/usr/bin/env python3
"""Fail-closed repository scanner that never prints detected secret values."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


SKIP_DIRS = {
    ".git",
    ".idea",
    ".next",
    ".pytest_cache",
    ".vscode",
    "__pycache__",
    "coverage",
    "node_modules",
}
DENIED_COMPONENTS = {"backups", "credentials", "memory", "secrets", "sessions", "state"}
DENIED_NAMES = {
    ".env",
    "config.json",
    "credentials.json",
    "openclaw.json",
    "secrets.json",
}
DENIED_SUFFIXES = {
    ".bak", ".crt", ".db", ".der", ".gz", ".key", ".log", ".p12", ".pem",
    ".pfx", ".sqlite", ".sqlite3", ".tar", ".tgz", ".zip",
}
SAFE_EXAMPLE_NAMES = {".env.example", "config.example.json"}
MAX_TEXT_BYTES = 2 * 1024 * 1024
ALLOW_LINE_MARKER = "secret-scan: allow"

SECRET_PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "openai-style-key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "anthropic-key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
    "google-api-key": re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    "github-token": re.compile(r"\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "slack-token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    "url-basic-auth": re.compile(r"https?://[^\s/:]+:[^\s/@]+@"),
    "generic-secret-assignment": re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b"
        r"\s*[:=]\s*[\"']?([^\s\"',;}{]{16,})"
    ),
    "private-home-path": re.compile(r"(?:/Users/(?!example(?:/|$))[^/\s]+|/home/(?!example(?:/|$))[^/\s]+)"),  # secret-scan: allow
    "private-ipv4": re.compile(r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b"),
    "non-example-project-session": re.compile(r"\bagent:[A-Za-z0-9._-]+:project-(?!(?:example|test)\b)[A-Za-z0-9._-]+\b"),
}

PLACEHOLDER_RE = re.compile(
    r"(?i)^(?:<[^>]+>|\$\{[^}]+\}|example|placeholder|replace[-_]?me|redacted|dummy|"
    r"not[-_]?a[-_]?real[-_]?secret|x{8,})$"
)


def git_files(root: Path) -> list[Path] | None:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return [root / value.decode("utf-8") for value in result.stdout.split(b"\0") if value]


def repository_files(root: Path, tracked_only: bool) -> list[Path]:
    if tracked_only:
        tracked = git_files(root)
        if tracked is None:
            raise RuntimeError("--tracked requires an initialized Git repository")
        return sorted(path for path in tracked if path.is_file())
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and not any(part in SKIP_DIRS for part in path.relative_to(root).parts)
    )


def denied_path(relative: Path) -> str | None:
    lowered = [part.casefold() for part in relative.parts]
    name = relative.name.casefold()
    if name in SAFE_EXAMPLE_NAMES:
        return None
    if any(part in DENIED_COMPONENTS for part in lowered[:-1]):
        return "denied-directory"
    if name in DENIED_NAMES or (name.startswith(".env.") and name != ".env.example"):
        return "denied-filename"
    if relative.suffix.casefold() in DENIED_SUFFIXES:
        return "denied-filetype"
    return None


def looks_binary(data: bytes) -> bool:
    return b"\0" in data[:8192]


def scan_text(relative: Path, text: str, forbidden: list[str]) -> list[tuple[int, str]]:
    findings: list[tuple[int, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if ALLOW_LINE_MARKER in line:
            continue
        for rule, pattern in SECRET_PATTERNS.items():
            for match in pattern.finditer(line):
                if rule == "generic-secret-assignment":
                    candidate = match.group(1).strip().strip("\"'")
                    if any(char in candidate for char in "().") or candidate.startswith("${{"):
                        continue
                    if PLACEHOLDER_RE.fullmatch(candidate):
                        continue
                findings.append((line_number, rule))
                break
        lowered = line.casefold()
        for value in forbidden:
            if value and value.casefold() in lowered:
                findings.append((line_number, "operator-forbidden-literal"))
    return findings


def scan(root: Path, tracked_only: bool, forbidden: list[str]) -> list[str]:
    findings: list[str] = []
    for path in repository_files(root, tracked_only):
        relative = path.relative_to(root)
        path_rule = denied_path(relative)
        if path_rule:
            findings.append(f"{relative}:0:{path_rule}")
            continue
        data = path.read_bytes()
        if len(data) > MAX_TEXT_BYTES or looks_binary(data):
            continue
        text = data.decode("utf-8", errors="replace")
        findings.extend(
            f"{relative}:{line_number}:{rule}"
            for line_number, rule in scan_text(relative, text, forbidden)
        )
    return findings


def self_test() -> None:
    secret = "sk" + "-" + ("A" * 36)
    assignment = "api_" + "key" + "=\"" + ("B" * 36) + "\""
    assert scan_text(Path("sample.txt"), secret, [])
    assert scan_text(Path("sample.txt"), assignment, [])
    assert not scan_text(Path("sample.txt"), 'api_key="${MODEL_API_KEY}"', [])
    with tempfile.TemporaryDirectory() as value:
        root = Path(value)
        (root / "safe.txt").write_text("no credentials here\n", encoding="utf-8")
        assert not scan(root, False, [])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=Path.cwd())
    parser.add_argument("--tracked", action="store_true", help="scan only paths tracked by Git")
    parser.add_argument("--forbid", action="append", default=[], help="additional private literal to reject")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("secret_scan self-test: ok")
        return 0
    root = args.root.resolve()
    findings = scan(root, args.tracked, list(args.forbid))
    if findings:
        print("secret_scan: blocked; potential private material detected", file=sys.stderr)
        for finding in findings:
            print(f"- {finding}", file=sys.stderr)
        print("Values are intentionally redacted. Remove the file/content before committing.", file=sys.stderr)
        return 2
    print(f"secret_scan: ok ({'tracked' if args.tracked else 'working tree'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
