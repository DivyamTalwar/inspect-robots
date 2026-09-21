"""Run the real Codex CLI in a disposable sandbox with no provider credentials."""

import json
import os
import selectors
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
from contextlib import suppress
from pathlib import Path


def unpack(archive_path, root):
    """Extract bounded regular source files without links or path traversal."""
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        if len(members) > 20000 or sum(m.size for m in members) > 100_000_000:
            raise ValueError("archive_too_large")
        for member in members:
            parts = Path(member.name).parts
            if (
                member.name.startswith("/")
                or ".." in parts
                or not (member.isfile() or member.isdir())
            ):
                raise ValueError("unsupported_archive_entry")
            if len(parts) < 2:
                continue
            target = root.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("wb") as out:
                    out.write(source.read())
                target.chmod(member.mode & 0o777)


def prepare_packages(workspace, environment, revision):
    """Build changed local Python packages offline as the same unprivileged user.

    Build a disposable copy so backend writes cannot contaminate the source diff.
    Failures remain visible to Codex; unsupported dependencies never block inspection.
    """
    head, base = workspace / "head", workspace / "base"
    projects = []
    for config in sorted(head.rglob("pyproject.toml")):
        relative = config.parent.relative_to(head)
        changed = (
            relative == Path(".")
            or any(
                not (base / f.relative_to(head)).is_file()
                or f.read_bytes() != (base / f.relative_to(head)).read_bytes()
                for f in config.parent.rglob("*")
                if f.is_file()
            )
            or any(
                not (head / f.relative_to(base)).is_file()
                for f in (base / relative).rglob("*")
                if f.is_file()
            )
        )
        if changed:
            projects.append(relative)
    build = workspace / "build-source"
    shutil.copytree(head, build)
    subprocess.run(["chown", "-R", "65534:65534", str(build)], check=True)
    deadline = time.monotonic() + 120
    results, executions = [], []
    for relative in projects:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            results.append({"package": str(relative), "status": "setup_time_limit"})
            continue
        command = [
            "/opt/review-env/bin/python",
            "-m",
            "pip",
            "install",
            "--no-deps",
            "--no-build-isolation",
            "--no-index",
            "--disable-pip-version-check",
            "--target",
            str(workspace / "python-packages"),
            str(build / relative),
        ]
        timed_out = False
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(
                command,
                cwd=build,
                env={**environment, "SETUPTOOLS_SCM_PRETEND_VERSION": "0.0.0"},
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                user=65534,
                group=65534,
                extra_groups=[],
            )
            try:
                code = process.wait(timeout=min(45, remaining))
            except subprocess.TimeoutExpired:
                timed_out = True
                code = None
            finally:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 6000))
            output = log.read().decode(errors="replace")
        results.append({"package": str(relative), "exitCode": code, "output": output})
        executions.append(
            {
                "revision": revision,
                "command": " ".join(command),
                "exitCode": code,
                "limit": "setup_timeout" if timed_out else None,
            }
        )
    (workspace / "setup.json").write_text(json.dumps(results))
    return executions


def main():
    """Launch a fresh CLI session and return only validated-shape diagnostics."""
    deadline = time.monotonic() + 1200
    request = json.loads(Path("/tmp/request.json").read_text())
    workspace = Path("/workspace/review")
    unpack("/tmp/head.tar.gz", workspace / "head")
    unpack("/tmp/base.tar.gz", workspace / "base")
    home = workspace / "home"
    home.mkdir()
    (home / ".codex").mkdir()
    (workspace / "context.json").write_text(request["context"])
    Path("/tmp/review-schema.json").write_text(request["schema"])
    subprocess.run(["chown", "-R", "65534:65534", str(workspace)], check=True)
    environment = {
        "PATH": "/opt/review-env/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": str(home),
        "CODEX_HOME": str(home / ".codex"),
        "PYTHONPATH": (
            f"{workspace}/python-packages:{workspace}/head/.review-packages:{workspace}/head/src"
        ),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PIP_NO_INDEX": "1",
        "UV_OFFLINE": "1",
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        "CI": "1",
    }
    executions = prepare_packages(workspace, environment, request["head"])
    prompt = (
        "Review the PR described in /workspace/review/context.json using the supplied policy. "
        "The complete immutable head snapshot is /workspace/review/head and its merge-base "
        "snapshot is /workspace/review/base. Start with git diff --no-index --stat and "
        "--name-status between those directories (exit 1 means differences, not failure). "
        "Read /workspace/review/setup.json for offline package installation results. "
        "Track changed-file coverage and inspect per-file diffs in bounded batches; do not "
        "dump the whole directory diff or context JSON. Read the PR description, relevant "
        "discussion and base CLAUDE.md, then prioritize changed code, tests and focused "
        "reproductions. Investigate correctness even if a product decision is pending. "
        "Assess usefulness and concrete maintenance tradeoffs without requiring a separate "
        "approval comment for routine in-scope work. Return the requested review JSON, "
        "naming any exact remaining checks and why they could not be completed. "
        "Do not modify GitHub or contact anyone."
    )
    args = [
        "codex",
        "exec",
        "--model",
        "gpt-6-astra",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--output-schema",
        "/tmp/review-schema.json",
        "-o",
        str(workspace / "result.json"),
        "-c",
        'model_reasoning_effort="high"',
        "-c",
        'model_provider="review_gateway"',
        "-c",
        'model_providers.review_gateway.name="Budgeted review gateway"',
        "-c",
        f'model_providers.review_gateway.base_url="http://review-model.local/{request["token"]}"',
        "-c",
        'model_providers.review_gateway.wire_api="responses"',
        "-c",
        "model_providers.review_gateway.requires_openai_auth=false",
        "-c",
        "model_providers.review_gateway.request_max_retries=0",
        "-c",
        "model_providers.review_gateway.stream_max_retries=0",
        "-c",
        "model_providers.review_gateway.stream_idle_timeout_ms=900000",
        "-c",
        "model_auto_compact_token_limit=200000",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "features.apps=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        'web_search="disabled"',
        "-c",
        "developer_instructions=" + json.dumps(request["policy"]),
        prompt,
    ]
    process = subprocess.Popen(
        args,
        cwd=workspace / "head",
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        user=65534,
        group=65534,
        extra_groups=[],
    )
    streams = selectors.DefaultSelector()
    streams.register(process.stdout, selectors.EVENT_READ, "stdout")
    streams.register(process.stderr, selectors.EVENT_READ, "stderr")
    pending = b""
    errors = bytearray()
    timed_out = False
    while streams.get_map():
        if time.monotonic() >= deadline:
            timed_out = True
            break
        for key, _ in streams.select(timeout=0.5):
            data = os.read(key.fd, 8192)
            if not data:
                streams.unregister(key.fileobj)
                continue
            if key.data == "stderr":
                errors.extend(data)
                del errors[:-4000]
                continue
            pending += data
            if len(pending) > 2_000_000:
                raise ValueError("codex_event_too_large")
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") in ("error", "turn.failed"):
                    errors.extend(json.dumps(event).encode())
                    del errors[:-4000]
                item = event.get("item", {})
                if (
                    event.get("type") == "item.completed"
                    and item.get("type") == "command_execution"
                    and len(executions) < 100
                ):
                    executions.append(
                        {
                            "revision": request["head"],
                            "command": str(item.get("command", ""))[:12000],
                            "exitCode": item.get("exit_code"),
                            "limit": None,
                        }
                    )
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    exit_code = process.wait(timeout=5)
    result = workspace / "result.json"
    review = (
        json.loads(result.read_text())
        if exit_code == 0 and result.is_file() and result.stat().st_size < 24000
        else None
    )
    # Only typed output leaves this container. Codex stderr and prompts may
    # include the scoped gateway token, so never publish/log them.
    failure = "model_timeout" if timed_out else ("codex_review_incomplete" if exit_code else None)
    if b"Review budget exhausted" in errors:
        failure = "budget_exhausted"
    elif b"Review billing hold" in errors:
        failure = "billing_hold"
    elif b"Review context limit reached" in errors:
        failure = "context_too_large"
    print(
        json.dumps(
            {"exitCode": exit_code, "failure": failure, "review": review, "executions": executions}
        )
    )


if __name__ == "__main__":
    main()
