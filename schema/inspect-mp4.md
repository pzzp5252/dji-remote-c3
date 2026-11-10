# Inspect original MP4/MOV metadata

`tools/inspect_mp4.py` is a standalone Python 3 standard-library CLI. It reads source files without changing them, hashing them, or scanning `mdat` sample payloads. It produces candidate comparison evidence, **not** a matching, archival, integrity-verification, or recording-start reconstruction tool. See [the V1 event contract](events.md).

**Container timestamps have unverified timezone semantics.** ISO strings are calendar renderings from the 1904-01-01 epoch, deliberately without `Z` or a timezone offset. They are not verified UTC or verified recording starts. A matching filename, byte count, timestamp, or duration does not prove identical content, lossless copying, or continuity between sequential/approximately 16 GB split files. Ambiguities remain for human confirmation.

## Inspect files or directories

Run from the repository root:

```sh
python3 tools/inspect_mp4.py --camera A camera-a/clip001.MP4 camera-a/clip002.MP4
python3 tools/inspect_mp4.py --camera B --recursive camera-b/ --output camera-b-report.json
python3 tools/inspect_mp4.py camera-a/ camera-b/ --output combined-report.json
python3 tools/inspect_mp4.py --ffprobe camera-a/clip001.MP4
```

| Option | Behavior |
|---|---|
| One or more positional paths | Inspect explicit files regardless of extension; discover media filenames in directories. |
| `-r`, `--recursive` | Recurse into directories; do not follow directory symlinks. Default is one directory level. |
| `--camera A`, `B`, or `unknown` | Apply this caller-supplied label to every file in this invocation. Default `unknown`; no camera is inferred. Use separate invocations when cameras need different labels. |
| `--output PATH` | Write UTF-8 JSON to this report file rather than stdout. Existing report files may be replaced; an input source, including a symlink or hard-link alias, must never be overwritten. |
| `--ffprobe` | Optionally run `ffprobe` found on `PATH` for format/stream metadata and tags. Not required for native inspection. |

Directory discovery considers `.mp4`, `.mov`, `.m4v`, `.m4a`, `.3gp`, `.3g2`, and `.qt`, case-insensitively. Other files are ignored in directories, but an explicitly supplied unsupported/invalid file is reported as an error. Entries are sorted within each directory and inputs retain their argument order; repeated lexical absolute paths are inspected once. The report keeps the first supplied path (directory children use their discovered path), original filename, and exact file byte count. It adds no execution timestamp, random identifiers, or hashes. JSON object keys are sorted for deterministic output from unchanged files and enrichment results.

Exit status is `0` only when all files, discovery, optional enrichment, and output succeed. Per-file errors do not prevent later files from being inspected. Status `1` accompanies an error report; command-line usage errors use argparse's status `2`. If the output path is refused or cannot be written, the report is emitted to stdout with an `output_error` instead, without truncating an aliased source. An empty directory selection is an error rather than a successful empty report.

## Read the JSON evidence

The top-level object contains `schema_version: 1`, `tool: "inspect_mp4"`, `time_semantics`, `limits`, ordered `files`, and discovery/output `errors`. Each error has `code` and `message`, plus byte `offset` when known. File errors are in the corresponding file's `errors`; native partial metadata remains available after errors.

| File field | Meaning |
|---|---|
| `path`, `name`, `file_size`, `camera` | Source path/name, exact bytes (or null when unavailable), supplied camera label. |
| `top_level_boxes` | Ordered box `type`, absolute `offset`, total `size`, `header_size`, and `size_encoding` (`32`, `64`, `to_end`). Compare this layout alongside names/sizes/durations for split-file samples; continuity is never asserted. |
| `file_types` | `ftyp` major brand, minor version, compatible brands, and truncation indicator. Brand alone is not treated as content verification. |
| `movie` | `mvhd` version, creation/modification timestamp objects, exact duration. Null if no readable movie header. |
| `tracks` | Each track's source offset, `tkhd` header, `mdhd` media timing/language, handler, sample descriptions, and native timecode evidence. Missing required track metadata is reported. |
| `native_tmcd_present` | True when a parsed track handler, sample entry, or track reference identifies native `tmcd`. False means none was found on supported paths, not proof that no vendor-specific timecode exists. |
| `metadata_bytes_read` | Bytes explicitly requested by the native parser, excluding seek distances and optional ffprobe reads. |
| `ffprobe` | Null unless requested; otherwise exit code, original JSON `data`, stderr text, and errors. Available format/stream tags and timecodes are preserved without normalization. |

Timestamp objects contain `raw_seconds_since_1904` and `iso_calendar_unverified`. Raw zero is retained, not interpreted as missing. Out-of-calendar-range values retain the raw integer and use null for the ISO rendering. Movie, track-header, and media-header creation and modification fields remain separate; none is promoted to recording start.

Durations use exact integer `numerator` and `timescale`, never a floating-point estimate. `tkhd` durations inherit the movie timescale; `mdhd` uses the media timescale. `is_unknown` identifies the all-ones duration sentinel while preserving its raw numerator. A zero timescale is an error; its raw duration is retained without division. Width/height are raw unsigned 16.16 values. Handler names are best-effort UTF-8; `language_raw` is retained alongside a possible ISO 639-2 rendering.

Native timecode metadata includes `tmcd` sample-entry flags, drop-frame flag, timescale, frame duration, raw `number_of_frames`, data-reference index, bounded extension bytes as hex, and referenced track IDs. This is **metadata presence**, not extraction of a starting timecode from sample payloads. No timecode is synthesized. Optional ffprobe tags may expose additional original timecode strings; their presence does not validate clock accuracy or synchronization with journal events.

## Bounds and unsupported cases

The native parser opens regular sources read-only and unbuffered, seeks across media/unknown boxes, and reads only bounded headers and selected metadata. It supports 32-bit sizes, extended 64-bit sizes, size-zero boxes extending to their enclosing boundary, and versions 0/1 of `mvhd`, `mdhd`, and `tkhd`. It checks each box against its enclosing/file boundary, rejects truncated or impossible lengths and unsupported header versions, and reports missing `moov`/`mvhd`. A structurally readable container is not proof of a decodable or intact video.

Per-file bounds are 10,000 box headers and 8 MiB of requested metadata, with no single native read larger than 64 KiB. Handler names, compatible-brand bytes, and timecode extensions are capped at 1,024 bytes with explicit truncation indicators. Oversized timecode-reference arrays fail rather than allocating unbounded memory. Only fixed container paths (`moov/trak/mdia/minf/stbl`, and track references) are traversed, so arbitrary recursive nesting is not followed. Unknown/vendor metadata is skipped; this is not a general metadata exporter. Source files must remain unchanged during inspection; truncation detected during reads is an error, but the tool does not lock sources or verify a snapshot.

There is no sample-table/packet validation, full-file corruption detection, compressed `cmov` decoding, fragmented timeline reconstruction, edit-list application, or vendor-specific timestamp correction. Native duration fields may be zero/unknown even for playable fragmented media. A failed/unfinished file without a usable `moov` remains an error, not an inferred duration.

Optional ffprobe runs with stream analysis disabled (`-nofind_stream_info`), requests only format/stream JSON, and does not request frames, packets, or raw sample dumps. Its own demuxer I/O is outside the native parser's accounting; omit `--ffprobe` when native-only I/O bounds are required. It has a 60-second timeout and a 1 MiB stdout / 1 MiB stderr capture limit. Missing executables, timeouts, excess output, invalid JSON, and nonzero ffprobe status are preserved as errors and cause status `1`; available JSON/stderr are retained. It does not replace native evidence or become a required dependency.

## Run behavioral tests

The regression suite uses synthetic version-0/version-1 containers and a sparse large-`mdat` file; no real footage or ffprobe installation is required:

```sh
python3 -m unittest discover -s tests -p 'test_inspect_mp4.py'
```

It covers bounded seeks, extended/to-end lengths, malformed/truncated/missing metadata, zero timescales, native timecode metadata, Unicode paths, output/source aliases, deterministic output, optional enrichment, directory discovery, and continued reporting after individual CLI file failures.
