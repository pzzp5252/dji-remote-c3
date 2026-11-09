#!/bin/sh
# Keeps the upstream GUI sdkconfig and build directory intact.
set -eu
cd "$(dirname "$0")/../.."
if ! command -v idf.py >/dev/null 2>&1; then
    echo 'Source ESP-IDF 5.5.x export.sh before running this script.' >&2
    exit 1
fi
idf.py -B build-c3 -D IDF_TARGET=esp32c3 \
    -D SDKCONFIG=sdkconfig.c3 \
    -D SDKCONFIG_DEFAULTS=sdkconfig.defaults.esp32c3_headless build
