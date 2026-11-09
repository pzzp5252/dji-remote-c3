#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bin=$(mktemp "${TMPDIR:-/tmp}/dji-remote-tests.XXXXXX")
trap 'rm -f "$bin"' EXIT
${CC:-clang} -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -I main/headless tests/test_dual_control.c main/headless/dual_control.c -o "$bin"
"$bin"
${CC:-clang} -std=c11 -Wall -Wextra -Werror -Wno-newline-eof -fsanitize=address,undefined \
    -I tests/stubs -I main -I ble -I logic -I protocol \
    tests/test_camera_status.c logic/status_logic.c logic/enums_logic.c -o "$bin"
"$bin"
sh tests/run_handshake_tests.sh
