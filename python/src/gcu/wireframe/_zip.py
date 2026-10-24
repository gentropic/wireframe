"""ZIP for .wfr: locating stored members by byte range, and a stored-only writer with Zip64 and
64-byte data alignment (SPEC §3). Reading leans on the standard library's zipfile for the central
directory and reads the local header itself to find where each member's bytes begin."""
from __future__ import annotations

import hashlib
import struct
import zipfile
import zlib
from dataclasses import dataclass

MAX32 = 0xFFFFFFFF
BLOCK = 16 * 1024 * 1024


@dataclass
class Member:
    name: str
    offset: int        # file offset of the member's data
    size: int
    method: int
    crc: int
    header_offset: int
    extra_len: int     # the LOCAL header's extra length


def members(path) -> dict[str, Member]:
    out = {}
    with zipfile.ZipFile(path) as z, open(path, "rb") as f:
        for info in z.infolist():
            f.seek(info.header_offset)
            lh = f.read(30)
            if lh[:4] != b"PK\x03\x04":
                raise ValueError(f"wfr: bad local header for {info.filename}")
            nlen, elen = struct.unpack("<HH", lh[26:30])
            out[info.filename] = Member(info.filename, info.header_offset + 30 + nlen + elen, info.compress_size,
                                        info.compress_type, info.CRC, info.header_offset, elen)
    return out


def sha256_blocks(data, block: int = BLOCK) -> list[str]:
    mv = memoryview(data)
    return [hashlib.sha256(mv[p:p + block]).hexdigest() for p in range(0, len(mv), block)]


class ZipWriter:
    """Stored members only; DOS time fixed at 1980-01-01 so output is deterministic."""

    def __init__(self, f, align: int = 64):
        self.f, self.align, self.offset, self.cd = f, align, 0, []

    def _put(self, b):
        self.f.write(b)
        self.offset += len(b)

    def add(self, name: str, data, aligned: bool = True) -> dict:
        data = memoryview(data).cast("B")
        nb, size, crc = name.encode("utf-8"), len(data), zlib.crc32(data) & MAX32
        big = size >= MAX32
        z64 = 20 if big else 0
        pad, do_align = 0, aligned and self.align > 1
        if do_align:
            base = self.offset + 30 + len(nb) + z64 + 6
            pad = (self.align - base % self.align) % self.align
        extra = b""
        if big:
            extra += struct.pack("<HHQQ", 1, 16, size, size)
        if do_align:
            extra += struct.pack("<HHH", 0xD935, 2 + pad, self.align) + b"\0" * pad
        hdr = struct.pack("<IHHHHHIIIHH", 0x04034B50, 45 if big else 20, 0x0800, 0, 0, 0x21, crc,
                          MAX32 if big else size, MAX32 if big else size, len(nb), len(extra))
        local = self.offset
        self._put(hdr + nb + extra)
        self._put(data)
        self.cd.append((nb, size, crc, local))
        return {"size": size, "sha256": sha256_blocks(data)}

    def finish(self) -> int:
        cd_start = self.offset
        for nb, size, crc, local in self.cd:
            need_size, need_off = size >= MAX32, local >= MAX32
            z = (16 if need_size else 0) + (8 if need_off else 0)
            extra = b""
            if z:
                extra = struct.pack("<HH", 1, z) + (struct.pack("<QQ", size, size) if need_size else b"") + (struct.pack("<Q", local) if need_off else b"")
            self._put(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 45, 45 if z else 20, 0x0800, 0, 0, 0x21, crc,
                                  MAX32 if need_size else size, MAX32 if need_size else size, len(nb), len(extra), 0, 0, 0, 0,
                                  MAX32 if need_off else local) + nb + extra)
        cd_size = self.offset - cd_start
        z64 = len(self.cd) > 0xFFFF or cd_start >= MAX32 or cd_size >= MAX32
        if z64:
            z_off = self.offset
            self._put(struct.pack("<IQHHIIQQQQ", 0x06064B50, 44, 45, 45, 0, 0, len(self.cd), len(self.cd), cd_size, cd_start))
            self._put(struct.pack("<IIQI", 0x07064B50, 0, z_off, 1))
        n = 0xFFFF if z64 else len(self.cd)
        self._put(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, n, n, MAX32 if z64 else cd_size, MAX32 if z64 else cd_start, 0))
        return self.offset
