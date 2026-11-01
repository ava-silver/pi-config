#!/usr/bin/env python3
"""Validate the front matter required by Agent skills."""

import sys
from pathlib import Path

import yaml


def validate(path: Path) -> list[str]:
    try:
        document = path.read_text(encoding="utf-8")
    except OSError as error:
        return [str(error)]

    if not document.startswith("---\n"):
        return ["must start with YAML front matter"]

    closing_delimiter = document.find("\n---\n", len("---\n"))
    if closing_delimiter == -1:
        return ["front matter must end with '---'"]

    try:
        metadata = yaml.safe_load(document[len("---\n") : closing_delimiter])
    except yaml.YAMLError as error:
        return [f"invalid YAML: {error}"]

    if not isinstance(metadata, dict):
        return ["front matter must be a mapping"]

    errors = []
    for key in ("name", "description"):
        if not isinstance(metadata.get(key), str) or not metadata[key].strip():
            errors.append(f"'{key}' must be a non-empty string")

    if metadata.get("name") != path.parent.name:
        errors.append(f"'name' must match directory '{path.parent.name}'")

    return errors


def main() -> int:
    failed = False
    for filename in sys.argv[1:]:
        path = Path(filename)
        for error in validate(path):
            print(f"{path}: {error}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
