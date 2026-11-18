#!/usr/bin/env bash
set -euo pipefail

nix_binary=$1
shift

# Comin invokes eval/derivation show to evaluate, then build on the resulting
# .drv path. Source substitution defeats Nix 2.35's lazy imports by unpacking
# all of nixpkgs. Disable it only for evaluation; builds keep binary caches.
for arg in "$@"; do
  case "$arg" in
    eval|derivation)
      exec "$nix_binary" --option substitute false "$@"
      ;;
    build)
      break
      ;;
  esac
done

exec "$nix_binary" "$@"
