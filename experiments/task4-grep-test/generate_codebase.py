#!/usr/bin/env python3
"""
Generate a synthetic 500-file Python codebase for the Grep Test diagnostic task.

Seeds legacy_auth() calls at known locations so scoring can verify accuracy.
Run: python generate_codebase.py [output_dir]
"""
import os
import random
import json
import sys

TOTAL_FILES = 500
SEEDED_FILES = 50       # files that contain legacy_auth()
CALLS_PER_FILE = (1, 4) # random range of calls per seeded file

MODULES = [
    "user_manager", "billing", "payments", "notifications", "dashboard",
    "settings", "reports", "export", "import_handler", "scheduler",
    "cache_manager", "session", "telemetry", "audit", "queue_worker",
    "api_gateway", "webhook", "file_upload", "search", "recommendation",
]

FUNCTION_TEMPLATES = [
    "def process_{name}(data):\n    result = {{}}\n    return result\n",
    "def validate_{name}(item):\n    if not item:\n        raise ValueError('invalid')\n    return True\n",
    "def fetch_{name}(id: int):\n    return None\n",
    "def update_{name}(id: int, **kwargs):\n    pass\n",
    "def delete_{name}(id: int) -> bool:\n    return True\n",
]

LEGACY_AUTH_CALL_TEMPLATES = [
    "    if not legacy_auth(user_id, token):\n        return None\n",
    "    legacy_auth(request.user_id, request.token)\n",
    "    authenticated = legacy_auth(uid, tok)\n    assert authenticated\n",
    "    result = legacy_auth(ctx['user'], ctx['auth_token'])\n",
]


def make_file_content(module: str, filename: str, auth_calls: list[str]) -> str:
    """Generate a realistic Python module with optional legacy_auth() calls."""
    rng = random.Random(hash(filename))
    lines = [
        f"# {module}.py — auto-generated for diagnostic testing\n",
        f"from typing import Any, Optional\n",
        f"import logging\n\n",
        f"logger = logging.getLogger(__name__)\n\n",
    ]

    # Add 3-8 functions
    n_funcs = rng.randint(3, 8)
    names = [f"{module}_{i}" for i in range(n_funcs)]

    for i, name in enumerate(names):
        tmpl = rng.choice(FUNCTION_TEMPLATES)
        lines.append(f"def {tmpl.format(name=name).rstrip()}\n")

        # Inject legacy_auth() call at a specific function if this is a seeded file
        if auth_calls and i < len(auth_calls):
            call = auth_calls[i]
            # Inject inside function body (indent preserved in template)
            func_lines = lines[-1].split("\n")
            # Find first empty line in body and insert there
            insert = func_lines[1] if len(func_lines) > 1 else ""
            lines[-1] = lines[-1].replace(insert, call + insert, 1)

        lines.append("\n")

    return "".join(lines)


def generate(output_dir: str) -> dict:
    """
    Generate the codebase. Returns ground truth dict:
    { "total_calls": N, "files": { "path": [line_numbers] } }
    """
    os.makedirs(output_dir, exist_ok=True)
    rng = random.Random(42)  # deterministic

    seeded = rng.sample(range(TOTAL_FILES), SEEDED_FILES)
    seeded_set = set(seeded)

    ground_truth: dict = {"total_calls": 0, "files": {}}

    for i in range(TOTAL_FILES):
        module = MODULES[i % len(MODULES)]
        subdir = f"pkg_{i // 50:02d}"
        os.makedirs(os.path.join(output_dir, subdir), exist_ok=True)
        filename = f"{module}_{i:04d}.py"
        rel_path = os.path.join(subdir, filename)
        abs_path = os.path.join(output_dir, rel_path)

        auth_calls: list[str] = []
        if i in seeded_set:
            n_calls = rng.randint(*CALLS_PER_FILE)
            auth_calls = [rng.choice(LEGACY_AUTH_CALL_TEMPLATES) for _ in range(n_calls)]

        content = make_file_content(module, filename, auth_calls)

        with open(abs_path, "w") as f:
            f.write(content)

        if auth_calls:
            # Record which lines contain legacy_auth
            line_nums = [
                j + 1
                for j, line in enumerate(content.splitlines())
                if "legacy_auth" in line
            ]
            ground_truth["files"][rel_path] = line_nums
            ground_truth["total_calls"] += len(line_nums)

    # Write ground truth for scorer
    with open(os.path.join(output_dir, "_ground_truth.json"), "w") as f:
        json.dump(ground_truth, f, indent=2)

    print(f"Generated {TOTAL_FILES} files in {output_dir}")
    print(f"Seeded {SEEDED_FILES} files with {ground_truth['total_calls']} legacy_auth() calls")
    print(f"Ground truth: {output_dir}/_ground_truth.json")
    return ground_truth


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/grep-test-codebase"
    generate(out)
