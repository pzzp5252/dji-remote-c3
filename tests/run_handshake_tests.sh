#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bin=$(mktemp "${TMPDIR:-/tmp}/dji-handshake-tests.XXXXXX")
trap 'rm -f "$bin"' EXIT
case "$(uname -s)" in Darwin) strip=-Wl,-dead_strip ;; *) strip=-Wl,--gc-sections ;; esac
${CC:-clang} -std=c11 -Wall -Wextra -Werror -Wno-unused-variable -Wno-newline-eof -ffunction-sections -fdata-sections -fsanitize=address,undefined \
    -I tests/handshake_stubs -I tests/stubs -I main -I ble -I logic -I protocol -I data \
    tests/test_pair_handshake.c logic/connect_logic.c "$strip" -o "$bin"
for scenario in 1 2 3 4 5 6 7 8 9; do "$bin" "$scenario"; done
