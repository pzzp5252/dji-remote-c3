#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bin=$(mktemp "${TMPDIR:-/tmp}/dji-remote-tests.XXXXXX")
trap 'rm -f "$bin"' EXIT
${CC:-clang} -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -I main/headless tests/test_dual_control.c main/headless/dual_control.c -o "$bin"
"$bin"
${CC:-clang} -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
    -I main/headless tests/test_capture.c main/headless/capture.c -o "$bin"
"$bin"
${CC:-clang} -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
    -I main/headless tests/test_phone_wire.c main/headless/phone_wire.c -o "$bin"
"$bin"
# Set CJSON_CFLAGS/CJSON_LIBS for a non-system cJSON installation.
for test in journal control_service phone_service; do
    sources="main/headless/journal.c"
    if [ "$test" = control_service ] || [ "$test" = phone_service ]; then
        sources="$sources main/headless/capture.c main/headless/control_service.c"
    fi
    if [ "$test" = phone_service ]; then
        sources="$sources main/headless/phone_service.c"
    fi
    ${CC:-clang} -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
        -I main/headless -I tests/stubs ${CJSON_CFLAGS:--I/usr/include/cjson} \
        "tests/test_$test.c" $sources ${CJSON_LIBS:--lcjson} -lm -o "$bin"
    "$bin"
done
python3 -m unittest discover -s tests -p test_inspect_mp4.py
node --test tests/test_phone_client.mjs
node --test tests/test_phone_ui.mjs
python3 -m unittest discover -s tests -p test_archive_pipeline.py
${CC:-clang} -std=c11 -Wall -Wextra -Werror -Wno-newline-eof -fsanitize=address,undefined \
    -I tests/stubs -I main -I ble -I logic -I protocol \
    tests/test_camera_status.c logic/status_logic.c logic/enums_logic.c -o "$bin"
"$bin"
sh tests/run_handshake_tests.sh
