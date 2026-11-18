import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


WRAPPER = Path(__file__).resolve().parents[1] / "scripts" / "comin-nix.sh"
COMMON = ["--extra-experimental-features", "flakes nix-command", "--accept-flake-config"]


class CominNixTests(unittest.TestCase):
    def invoke(self, arguments):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "nix"
            binary.write_text(f"#!{sys.executable}\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
            binary.chmod(0o755)
            result = subprocess.check_output(["bash", str(WRAPPER), str(binary), *arguments], text=True)
            return json.loads(result)

    def test_evaluation_skips_source_substitution(self):
        for command in (["eval", "flake#machineId", "--raw"],
                        ["derivation", "show", "flake#system", "-L", "--show-trace"]):
            with self.subTest(command=command):
                arguments = COMMON + command
                self.assertEqual(self.invoke(arguments), ["--option", "substitute", "false", *arguments])

    def test_build_keeps_binary_cache_and_exact_arguments(self):
        arguments = COMMON + ["build", "/nix/store/example.drv^*", "-L", "--no-link"]
        self.assertEqual(self.invoke(arguments), arguments)

    def test_other_commands_pass_through(self):
        arguments = ["--version"]
        self.assertEqual(self.invoke(arguments), arguments)
