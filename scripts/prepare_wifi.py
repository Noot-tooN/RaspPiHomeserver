"""Write a Wi-Fi keyfile to an already-flashed boot card, never into the image."""

import argparse
import getpass
import os
from pathlib import Path


def keyfile_value(value):
    # GLib keyfile string escaping; preserve spaces in SSIDs and passphrases.
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t").replace(" ", "\\s")


def render(ssid, password):
    if not 1 <= len(ssid.encode()) <= 32:
        raise ValueError("SSID must be between 1 and 32 bytes")
    if not (8 <= len(password) <= 63 or
            (len(password) == 64 and all(c in "0123456789abcdefABCDEF" for c in password))):
        raise ValueError("Use a WPA-Personal passphrase of 8–63 characters or a 64-digit hex PSK")
    # NM also accepts SSIDs as a byte list. Always use that unambiguous form:
    # a literal SSID such as "65;66;" must not accidentally become "AB".
    encoded_ssid = ";".join(str(byte) for byte in ssid.encode()) + ";"
    return (
        "[connection]\nid=rasppi-wifi\ntype=wifi\nautoconnect=true\n\n"
        f"[wifi]\nmode=infrastructure\nssid={encoded_ssid}\n\n"
        f"[wifi-security]\nkey-mgmt=wpa-psk\npsk={keyfile_value(password)}\n\n"
        "[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("boot_partition", type=Path, help="Mounted FAT boot partition")
    args = parser.parse_args()
    if not (args.boot_partition / "config.txt").is_file():
        parser.error("Expected a mounted Raspberry Pi boot partition containing config.txt")
    try:
        content = render(input("Wi-Fi network name: "), getpass.getpass("Wi-Fi password: "))
        path = args.boot_partition / "rasppi-wifi.nmconnection"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(content)
        print(f"Wrote {path}. The Pi will import and remove it from the boot partition.")
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")
