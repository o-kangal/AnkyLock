#!/usr/bin/env bash
# Heuristic first-pass scanner for zero-knowledge crypto violations.
# Usage: scan.sh [path...]   (defaults to packages apps)
# Every hit is a lead to verify by reading the code, not a confirmed violation.
set -uo pipefail

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(packages apps)

existing=()
for t in "${targets[@]}"; do [ -e "$t" ] && existing+=("$t"); done
if [ ${#existing[@]} -eq 0 ]; then
  echo "No existing paths among: ${targets[*]}"
  exit 0
fi

GREP=(grep -rnE --include=*.ts --include=*.tsx --include=*.js --include=*.rs
      --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist)

hits=0
check() {
  local label="$1" pattern="$2"; shift 2
  local out
  out=$("${GREP[@]}" "$@" -e "$pattern" "${existing[@]}" 2>/dev/null)
  if [ -n "$out" ]; then
    echo "### $label"
    echo "$out"
    echo
    hits=$((hits + $(printf '%s\n' "$out" | wc -l)))
  fi
}

check "Non-crypto RNG (Math.random / rand::thread_rng near crypto)" 'Math\.random|thread_rng\(\)'
check "Possibly constant / caller-supplied IV" '(iv|nonce)\s*[:=]\s*(new Uint8Array\(12\)\s*[,;)]|\[0|Uint8Array\.from\(|["'"'"'`])'
check "IV passed in as parameter (should be generated inside encrypt)" 'function\s+encrypt\w*\s*\([^)]*\biv\b'
check "Key material in Web Storage" '(localStorage|sessionStorage)\.(setItem|getItem)\s*\([^)]*(key|mek|secret|pass)'
check "Node crypto / fs / path import in shared code" "from\s+['\"](node:)?(crypto|fs|path)['\"]|require\(['\"](node:)?(crypto|fs|path)['\"]\)"
check "Extractable keys" 'extractable\s*:\s*true|,\s*true\s*,\s*\[\s*["'"'"']?(encrypt|decrypt|wrapKey)'
check "Plaintext fields logged" '(console\.(log|info|debug|warn|error)|tracing::(info|debug|warn|error)!|println!|eprintln!)\s*\([^)]*(title|body|content|folderName|categoryName|plaintext|name\b)'
check "Plaintext fields serialized near sync sinks" '(JSON\.stringify|serde_json::to_)\w*\([^)]*(title|body|plaintext|folderName|categoryName)'
check "Outbox / socket writes (verify payload is encrypted)" 'sync_outbox|\.send\(|encrypted_payload|encrypted_envelope'
check "Key derived from OAuth material" '(deriveKey|importKey|pbkdf2)[^;]*(oauth|id_token|access_token|googleUser|email)'

echo "---"
echo "$hits lead(s). Read each in context; trace sinks manually (see SKILL.md Part 2 step 2)."
