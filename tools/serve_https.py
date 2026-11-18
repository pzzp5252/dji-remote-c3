#!/usr/bin/env python3
"""Serve phone/ over HTTPS on the Mac LAN for iPhone Bluefy Web Bluetooth testing."""

import argparse
from functools import partial
import http.server
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile


DEFAULT_ROOT = Path(__file__).resolve().parent.parent / "phone"


class StaticFieldHandler(http.server.SimpleHTTPRequestHandler):
    """Serve ES modules with accurate MIME types and no-store cache headers."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "application/javascript; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def detect_lan_ip():
    """Return the preferred LAN IPv4 address for display, or 127.0.0.1."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def create_self_signed_cert(temp_dir, lan_ip):
    """Generate a temporary self-signed EC/RSA cert via openssl for LAN HTTPS."""
    openssl = shutil.which("openssl")
    if not openssl:
        raise RuntimeError("openssl is required for --self-signed")
    cert_path = Path(temp_dir) / "dev-cert.pem"
    key_path = Path(temp_dir) / "dev-key.pem"
    ext_path = Path(temp_dir) / "san.cnf"
    san_entries = ["DNS:localhost", "IP:127.0.0.1"]
    if lan_ip and lan_ip != "127.0.0.1":
        san_entries.append(f"IP:{lan_ip}")
    ext_path.write_text(
        "[req]\n"
        "distinguished_name=dn\n"
        "x509_extensions=v3_req\n"
        "prompt=no\n"
        "[dn]\n"
        f"CN={lan_ip or 'localhost'}\n"
        "[v3_req]\n"
        "basicConstraints=CA:FALSE\n"
        "keyUsage=digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        f"subjectAltName={','.join(san_entries)}\n",
        encoding="utf-8",
    )
    subprocess.run(
        [
            openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key_path), "-out", str(cert_path),
            "-days", "7", "-config", str(ext_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    return cert_path, key_path


def print_bluefy_instructions(lan_ip, port, *, self_signed):
    print(f"Serving phone/ over HTTPS:")
    print(f"  LAN (iPhone Bluefy): https://{lan_ip}:{port}/")
    print(f"  Localhost (Chrome):  https://127.0.0.1:{port}/  (demo: ?mock=1)")
    print()
    if self_signed:
        print("Using temporary --self-signed certificate (valid 7 days).")
        print("In iPhone Bluefy / Safari:")
        print("  1. If prompted 'This Connection Is Not Private', continue/trust for LAN testing,")
        print("     or use mkcert for a clean trusted LAN certificate (recommended for Service Worker).")
    else:
        print("Using provided TLS certificate.")
    print("Recommended mkcert setup for iPhone Bluefy (supports Service Worker & clean PWA):")
    print(f"  1. brew install mkcert && mkcert -install")
    print(f"  2. mkcert -cert-file /tmp/scoter-cert.pem -key-file /tmp/scoter-key.pem {lan_ip} localhost 127.0.0.1")
    print('  3. AirDrop "$(mkcert -CAROOT)/rootCA.pem" to iPhone -> Settings -> Profile Downloaded -> Install')
    print("  4. iPhone Settings -> General -> About -> Certificate Trust Settings -> Enable rootCA")
    print(f"  5. python3 tools/serve_https.py --cert /tmp/scoter-cert.pem --key /tmp/scoter-key.pem --port {port}")
    print()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=str(DEFAULT_ROOT), help="Directory to serve (default: phone/)")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8443, help="HTTPS port (default: 8443)")
    parser.add_argument("--cert", help="TLS certificate PEM path (e.g. from mkcert)")
    parser.add_argument("--key", help="TLS private key PEM path (e.g. from mkcert)")
    parser.add_argument(
        "--self-signed",
        action="store_true",
        help="Generate an ephemeral openssl self-signed cert for quick testing",
    )
    args = parser.parse_args(argv)

    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(f"Directory not found: {root}", file=sys.stderr)
        return 1
    if bool(args.cert) != bool(args.key):
        print("Both --cert and --key must be provided together.", file=sys.stderr)
        return 2
    if not args.cert and not args.self_signed:
        lan_ip = detect_lan_ip()
        print("No --cert/--key provided. Pass --cert and --key (recommended: mkcert) or --self-signed.", file=sys.stderr)
        print_bluefy_instructions(lan_ip, args.port, self_signed=False)
        return 2

    lan_ip = detect_lan_ip()
    temp_ctx = tempfile.TemporaryDirectory(prefix="scoter-https-") if args.self_signed and not args.cert else None
    try:
        if temp_ctx is not None:
            cert_path, key_path = create_self_signed_cert(temp_ctx.name, lan_ip)
        else:
            cert_path, key_path = Path(args.cert), Path(args.key)
            if not cert_path.is_file() or not key_path.is_file():
                print(f"Certificate or key file missing: {cert_path}, {key_path}", file=sys.stderr)
                return 1

        handler = partial(StaticFieldHandler, directory=str(root))
        server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        print_bluefy_instructions(lan_ip, args.port, self_signed=bool(args.self_signed and not args.cert))
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
        finally:
            server.server_close()
        return 0
    finally:
        if temp_ctx is not None:
            temp_ctx.cleanup()


if __name__ == "__main__":
    sys.exit(main())
