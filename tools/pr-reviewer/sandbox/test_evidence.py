"""Offline Linux/container regression for PR-supplied build code.

Run as root in the review image: python /tests/test_evidence.py
"""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

spec = importlib.util.spec_from_file_location("runner", "/opt/codex-review.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

BACKEND = r"""
import json, os, shutil, zipfile
from pathlib import Path
def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    build = Path.cwd()
    workspace = build.parent
    attempts = {}
    operations = {
        'overwrite_source': lambda: (workspace/'head/source.py').write_text('base'),
        'chmod_source': lambda: (workspace/'head/source.py').chmod(0o666),
        'remove_head': lambda: shutil.rmtree(workspace/'head'),
        'rename_head': lambda: (workspace/'head').rename(workspace/'hidden-head'),
        'replace_context': lambda: (workspace/'context.json').write_text('{}'),
        'unlink_context': lambda: (workspace/'context.json').unlink(),
        'chmod_parent': lambda: workspace.chmod(0o777),
        'replace_parent': lambda: workspace.rename(workspace.parent/'hidden-review'),
        'forge_setup': lambda: (workspace/'setup.json').write_text('[]'),
        'forge_result': lambda: (workspace/'output/result.json').write_text('APPROVE'),
        'modify_codex_home': lambda: (workspace/'home/config.toml').write_text('bad'),
    }
    for name, action in operations.items():
        try:
            action()
            attempts[name] = 'ALLOWED'
        except PermissionError:
            attempts[name] = 'DENIED'
    (build/'tamper-attempts.json').write_text(json.dumps(attempts))
    name = 'evidence_probe-0.0.0-py3-none-any.whl'
    with zipfile.ZipFile(Path(wheel_directory)/name, 'w') as wheel:
        wheel.writestr('evidence_probe.py', 'VALUE = 42\n')
        wheel.writestr('evidence_probe-0.0.0.dist-info/METADATA',
                      'Metadata-Version: 2.1\nName: evidence-probe\nVersion: 0.0.0\n')
        wheel.writestr('evidence_probe-0.0.0.dist-info/WHEEL',
                      'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
        wheel.writestr('evidence_probe-0.0.0.dist-info/RECORD', '')
    return name
"""


@unittest.skipUnless(os.geteuid() == 0, "requires the container's root launcher")
class EvidenceIsolation(unittest.TestCase):
    """PR code must not change the evidence used to review that same PR."""

    def test_build_backend_cannot_replace_evidence_or_forge_output(self):
        """Run a real malicious offline build, then verify canonical evidence remains."""
        with tempfile.TemporaryDirectory(prefix="review-evidence-") as parent:
            workspace = Path(parent) / "review"
            for tree in ("base", "head"):
                (workspace / tree).mkdir(parents=True)
            (workspace / "base/source.py").write_text("base")
            (workspace / "head/source.py").write_text("proposed change")
            (workspace / "head/source.py").chmod(0o777)  # Attacker-selected archive mode.
            context = '{"maintainer_decisions": ["review this PR"]}'
            (workspace / "context.json").write_text(context)
            (workspace / "head/pyproject.toml").write_text(
                '[build-system]\nrequires=[]\nbuild-backend="backend"\nbackend-path=["."]\n'
            )
            (workspace / "head/backend.py").write_text(BACKEND)
            runner.protect_evidence(workspace)
            self.assertTrue((workspace / "home/.codex").is_dir())
            self.assertEqual((workspace / "home/.codex").stat().st_uid, 65534)
            environment = {
                "PATH": "/opt/review-env/bin:/usr/local/bin:/usr/bin:/bin",
                "HOME": str(workspace / "home"),
                "PIP_NO_INDEX": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            executions = runner.prepare_packages(workspace, environment, "a" * 40)
            setup = json.loads((workspace / "setup.json").read_text())
            self.assertEqual(executions[0]["exitCode"], 0, setup)
            attempts = json.loads((workspace / "build-source/tamper-attempts.json").read_text())
            self.assertEqual(set(attempts.values()), {"DENIED"}, attempts)
            self.assertEqual(len(attempts), 11)
            self.assertEqual((workspace / "head/source.py").read_text(), "proposed change")
            self.assertEqual((workspace / "base/source.py").read_text(), "base")
            self.assertEqual((workspace / "context.json").read_text(), context)
            self.assertTrue((workspace / "python-packages/evidence_probe.py").is_file())
            # Review shell commands get the same immutable evidence, but can write scratch.
            code = """import pathlib, shutil, os
w=pathlib.Path(os.environ['WORKSPACE'])
for p in [w/'head/source.py',w/'context.json',w/'setup.json']:
 try: p.write_text('tampered')
 except PermissionError: pass
 else: raise AssertionError(str(p))
shutil.copytree(w/'head',w/'scratch/copy')
p=w/'scratch/copy/source.py';p.chmod(0o644);p.write_text('reproduction')
(w/'output/result.json').write_text('{}')
"""
            check = subprocess.run(
                ["/opt/review-env/bin/python", "-c", code],
                env={**environment, "WORKSPACE": str(workspace)},
                user=65534,
                group=65534,
                extra_groups=[],
                capture_output=True,
                text=True,
            )
            self.assertEqual(check.returncode, 0, check.stderr)
            diff = subprocess.run(
                [
                    "git",
                    "diff",
                    "--no-index",
                    "--",
                    str(workspace / "base"),
                    str(workspace / "head"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(diff.returncode, 1)
            self.assertIn("+proposed change", diff.stdout)

    def test_real_codex_starts_with_protected_workspace_and_offline_provider(self):
        """Exercise actual CLI startup and output with a local synthetic model."""
        text = "startup-ok"
        part = {"type": "output_text", "text": text, "annotations": []}
        item = {
            "type": "message",
            "id": "msg_probe",
            "role": "assistant",
            "status": "completed",
            "content": [part],
        }
        response = {
            "id": "resp_probe",
            "object": "response",
            "created_at": 1,
            "status": "completed",
            "model": "gpt-6-astra",
            "output": [item],
            "usage": {"input_tokens": 10, "output_tokens": 10, "total_tokens": 20},
        }
        events = [
            {
                "type": "response.created",
                "response": {**response, "status": "in_progress", "output": []},
            },
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {**item, "status": "in_progress", "content": []},
            },
            {
                "type": "response.content_part.added",
                "item_id": item["id"],
                "output_index": 0,
                "content_index": 0,
                "part": {**part, "text": ""},
            },
            {
                "type": "response.output_text.delta",
                "item_id": item["id"],
                "output_index": 0,
                "content_index": 0,
                "delta": text,
            },
            {
                "type": "response.output_text.done",
                "item_id": item["id"],
                "output_index": 0,
                "content_index": 0,
                "text": text,
            },
            {
                "type": "response.content_part.done",
                "item_id": item["id"],
                "output_index": 0,
                "content_index": 0,
                "part": part,
            },
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": response},
        ]
        payload = "".join("data: " + json.dumps(e) + "\n\n" for e in events).encode()

        class Provider(BaseHTTPRequestHandler):
            """Serve fixed Responses events without credentials or external network."""

            def do_POST(self):
                """Return one deterministic assistant response."""
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                """Keep request text out of test output."""

        with HTTPServer(("127.0.0.1", 0), Provider) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with tempfile.TemporaryDirectory(prefix="review-startup-") as parent:
                    workspace = Path(parent) / "review"
                    for tree in ("head", "base"):
                        (workspace / tree).mkdir(parents=True)
                    (workspace / "context.json").write_text("{}")
                    runner.protect_evidence(workspace)
                    output = workspace / "output/result.json"
                    args = [
                        "codex",
                        "exec",
                        "--model",
                        "gpt-6-astra",
                        "--ignore-user-config",
                        "--ignore-rules",
                        "--skip-git-repo-check",
                        "--ephemeral",
                        "--dangerously-bypass-approvals-and-sandbox",
                        "--json",
                        "-o",
                        str(output),
                    ]
                    settings = [
                        'model_provider="fixture"',
                        'model_providers.fixture.name="Offline"',
                        'model_providers.fixture.wire_api="responses"',
                        "model_providers.fixture.requires_openai_auth=false",
                        "model_providers.fixture.request_max_retries=0",
                        "model_providers.fixture.stream_max_retries=0",
                        f'model_providers.fixture.base_url="http://127.0.0.1:{server.server_port}"',
                    ]
                    for setting in settings:
                        args.extend(["-c", setting])
                    args.append("Return startup-ok.")
                    result = subprocess.run(
                        args,
                        cwd=workspace / "head",
                        env={
                            "PATH": "/usr/local/bin:/usr/bin:/bin",
                            "HOME": str(workspace / "home"),
                            "CODEX_HOME": str(workspace / "home/.codex"),
                        },
                        user=65534,
                        group=65534,
                        extra_groups=[],
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_text().strip(), text)
            finally:
                server.shutdown()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
