import os
import sys
import time
import random
import logging
import subprocess
import json
import shutil
import hashlib
import urllib.parse
import threading
from datetime import datetime
import tkinter as tk
from tkinter import filedialog
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("file-eraser-web.log", "w"),
        logging.StreamHandler(sys.stdout)
    ]
)

CHUNK_SIZE = 1048576  # 1 MB

# Registry of in-flight jobs so a separate /api/cancel request (its own thread
# under ThreadingHTTPServer) can signal a running wipe to stop.
ACTIVE_JOBS = {}
JOBS_LOCK = threading.Lock()


def register_job(job_id):
    if not job_id:
        return
    with JOBS_LOCK:
        ACTIVE_JOBS[job_id] = {"cancel": False, "proc": None}


def unregister_job(job_id):
    if not job_id:
        return
    with JOBS_LOCK:
        ACTIVE_JOBS.pop(job_id, None)


def is_cancelled(job_id):
    if not job_id:
        return False
    with JOBS_LOCK:
        job = ACTIVE_JOBS.get(job_id)
        return bool(job and job["cancel"])


def attach_proc(job_id, proc):
    with JOBS_LOCK:
        job = ACTIVE_JOBS.get(job_id)
        if job:
            job["proc"] = proc


def format_hex_data(data: bytes, start_offset: int = 0) -> list:
    """Formats bytes into a list of dicts for hex view: offset, hex bytes list, ascii representation."""
    hex_rows = []
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        offset_str = f"{start_offset + i:08X}"
        hex_bytes = [f"{b:02X}" for b in chunk]
        while len(hex_bytes) < 16:
            hex_bytes.append("")

        ascii_chars = []
        for b in chunk:
            ascii_chars.append(chr(b) if 32 <= b <= 126 else ".")
        ascii_str = "".join(ascii_chars)

        hex_rows.append({
            "offset": offset_str,
            "bytes": hex_bytes,
            "ascii": ascii_str
        })
    return hex_rows


def overwrite_file(path, size, fill, job_id=None, on_progress=None):
    """Overwrite exactly the first `size` bytes of `path` in place.

    `fill(n)` must return exactly `n` bytes. Returns the number of bytes
    written; stops early and returns partial count if the job is cancelled."""
    written = 0
    with open(path, "r+b") as f:
        f.seek(0)
        remaining = size
        while remaining > 0:
            if is_cancelled(job_id):
                break
            n = min(CHUNK_SIZE, remaining)
            f.write(fill(n))
            remaining -= n
            written += n
            if on_progress:
                on_progress(written)
        f.flush()
        os.fsync(f.fileno())
    return written


def sha256_of_file(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(CHUNK_SIZE), b""):
                h.update(block)
        return h.hexdigest()
    except Exception as e:
        logging.warning(f"Could not hash {path}: {e}")
        return None


def extract_strings(path, min_len=4, max_bytes=10 * 1048576, max_results=800):
    """Scan a file for runs of printable ASCII (like the unix `strings` tool),
    which is how a user spots hidden/embedded messages inside any file type."""
    results = []
    current = bytearray()
    run_start = 0
    consumed = 0
    with open(path, "rb") as f:
        while consumed < max_bytes:
            block = f.read(CHUNK_SIZE)
            if not block:
                break
            for i, b in enumerate(block):
                if 32 <= b <= 126:
                    if not current:
                        run_start = consumed + i
                    current.append(b)
                else:
                    if len(current) >= min_len:
                        results.append({"offset": f"{run_start:08X}", "text": current.decode("ascii", "replace")})
                        if len(results) >= max_results:
                            return results
                    current = bytearray()
            consumed += len(block)
    if len(current) >= min_len and len(results) < max_results:
        results.append({"offset": f"{run_start:08X}", "text": current.decode("ascii", "replace")})
    return results


def query_media_type(drive_letter):
    """Best-effort SSD/HDD classification for a drive letter via PowerShell."""
    if not drive_letter:
        return "Unspecified"
    try:
        ps_cmd = (
            f"Get-Partition -DriveLetter {drive_letter} | Get-Disk | Get-PhysicalDisk | "
            "Select-Object -Property MediaType | ConvertTo-Json"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_cmd],
            capture_output=True, text=True, timeout=6
        )
        if result.returncode == 0 and result.stdout.strip():
            info = json.loads(result.stdout.strip())
            if isinstance(info, dict) and info.get("MediaType"):
                return info["MediaType"]
            if isinstance(info, list) and info and info[0].get("MediaType"):
                return info[0]["MediaType"]
    except Exception as pe:
        logging.warning(f"Failed to query disk media type: {pe}")
    return "Unspecified"


def build_certificate_json(records):
    payload = {
        "application": "File Eraser X1",
        "certificate": "Certificate of Secure Erasure",
        "generated_utc": datetime.utcnow().isoformat() + "Z",
        "record_count": len(records),
        "records": records,
    }
    return json.dumps(payload, indent=2).encode("utf-8")


def build_certificate_pdf(records):
    """Hand-rolled single-page PDF (zero third-party deps) listing each wipe."""
    lines = [
        "File Eraser X1  -  Certificate of Secure Erasure",
        "Generated (UTC): " + datetime.utcnow().isoformat() + "Z",
        "Files erased: %d" % len(records),
        "",
    ]
    for i, r in enumerate(records, 1):
        lines.append("%d.  %s" % (i, r.get("filename", "")))
        lines.append("      Path:    %s" % r.get("path", ""))
        lines.append("      Size:    %s bytes" % r.get("size", 0))
        lines.append("      SHA-256: %s" % (r.get("sha256") or "n/a"))
        lines.append("      Method:  %s" % r.get("method", ""))
        lines.append("      Passes:  %s" % r.get("passes", ""))
        lines.append("      Verified: %s" % r.get("verified"))
        lines.append("      Completed: %s" % r.get("timestamp", ""))
        lines.append("")

    def esc(s):
        return str(s).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    leading = 14
    height = max(792, 80 + leading * (len(lines) + 2))
    content = "BT\n/F1 10 Tf\n%d TL\n40 %d Td\n" % (leading, height - 50)
    for ln in lines:
        content += "(%s) Tj T*\n" % esc(ln)
    content += "ET"
    content_bytes = content.encode("latin-1", "replace")

    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 %d] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>" % height,
        "<< /Length %d >>\nstream\n%s\nendstream" % (len(content_bytes), content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    ]

    pdf = "%PDF-1.4\n"
    offsets = []
    for idx, obj in enumerate(objs, 1):
        offsets.append(len(pdf.encode("latin-1", "replace")))
        pdf += "%d 0 obj\n%s\nendobj\n" % (idx, obj)
    xref_pos = len(pdf.encode("latin-1", "replace"))
    pdf += "xref\n0 %d\n" % (len(objs) + 1)
    pdf += "0000000000 65535 f \n"
    for off in offsets:
        pdf += "%010d 00000 n \n" % off
    pdf += "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref_pos)
    return pdf.encode("latin-1", "replace")


class SecureEraserRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep the console focused on our own logging

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    # ---- helpers -------------------------------------------------------
    def _json(self, obj, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode("utf-8"))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # Deliberately no keep-alive: the fetch reader detects end-of-stream on
        # connection close, and advertising keep-alive without a Content-Length
        # makes simple HTTP/1.0 clients hang waiting for more data.
        self.send_header("Connection", "close")
        self.end_headers()

    def _sse(self, obj):
        self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode("utf-8"))
        self.wfile.flush()

    # ---- routing -------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/file-info":
            self.handle_file_info(query)
        elif path == "/api/hex-data":
            self.handle_hex_data(query)
        elif path == "/api/strings":
            self.handle_strings(query)
        elif path == "/api/drives":
            self.handle_drives()
        else:
            self.serve_static_file(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/browse":
            self.handle_browse()
        elif path == "/api/erase":
            self.handle_erase()
        elif path == "/api/cancel":
            self.handle_cancel()
        elif path == "/api/wipe-free-space":
            self.handle_wipe_free_space()
        elif path == "/api/certificate":
            self.handle_certificate()
        else:
            self.send_error(404, "Not Found")

    # ---- static --------------------------------------------------------
    def serve_static_file(self, path):
        if path == "/":
            path = "/index.html"
        frontend_dist = os.path.join(os.path.dirname(__file__), "frontend", "dist")
        local_path = os.path.abspath(os.path.join(frontend_dist, path.lstrip("/")))
        if not local_path.startswith(os.path.abspath(frontend_dist)):
            self.send_error(403, "Forbidden")
            return

        if os.path.isfile(local_path):
            ext = os.path.splitext(local_path)[1].lower()
            content_type = {
                ".html": "text/html", ".js": "application/javascript",
                ".css": "text/css", ".svg": "image/svg+xml",
                ".json": "application/json", ".png": "image/png",
            }.get(ext, "application/octet-stream")
            try:
                with open(local_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            except Exception as e:
                logging.error(f"Error serving {local_path}: {e}")
                self.send_error(500, "Internal Server Error")
            return

        index_path = os.path.join(frontend_dist, "index.html")
        if path != "/index.html" and os.path.exists(index_path):
            self.serve_static_file("/index.html")
        else:
            self._json({"message": "Secure File Eraser Backend Server is running."})

    # ---- file inspection ----------------------------------------------
    def handle_file_info(self, query):
        path = (query.get("path") or [""])[0]
        if not path:
            return self._json({"detail": "Missing path parameter"}, 400)
        if not os.path.exists(path):
            return self._json({"detail": "File does not exist"}, 404)
        if not os.path.isfile(path):
            return self._json({"detail": "Path is not a file"}, 400)
        try:
            size = os.path.getsize(path)
            drive, _ = os.path.splitdrive(path)
            drive_letter = drive.rstrip(":")
            media_type = query_media_type(drive_letter) if drive_letter else "Unspecified"
            self._json({
                "path": path,
                "filename": os.path.basename(path),
                "size": size,
                "drive": drive,
                "media_type": media_type,
            })
        except Exception as e:
            logging.error(f"Error retrieving file info: {e}")
            self.send_error(500, str(e))

    def handle_hex_data(self, query):
        path = (query.get("path") or [""])[0]
        if not path:
            return self._json({"detail": "Missing path parameter"}, 400)
        if not os.path.exists(path):
            return self._json({"detail": "File does not exist"}, 404)
        try:
            offset = max(0, int((query.get("offset") or ["0"])[0]))
            length = int((query.get("length") or ["512"])[0])
            length = max(16, min(length, 4096))
            total = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(offset)
                data = f.read(length)
            self._json({
                "hex_rows": format_hex_data(data, offset),
                "offset": offset,
                "length": len(data),
                "total_size": total,
            })
        except Exception as e:
            logging.error(f"Error reading hex data: {e}")
            self.send_error(500, str(e))

    def handle_strings(self, query):
        path = (query.get("path") or [""])[0]
        if not path or not os.path.exists(path):
            return self._json({"detail": "File does not exist"}, 404)
        try:
            min_len = max(3, min(int((query.get("min") or ["4"])[0]), 32))
            strings = extract_strings(path, min_len=min_len)
            self._json({"strings": strings, "count": len(strings), "min_len": min_len})
        except Exception as e:
            logging.error(f"Error scanning strings: {e}")
            self.send_error(500, str(e))

    def handle_drives(self):
        drives = []
        try:
            letters = os.listdrives() if hasattr(os, "listdrives") else \
                [f"{c}:\\" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(f"{c}:\\")]
            for d in letters:
                try:
                    usage = shutil.disk_usage(d)
                    drives.append({
                        "drive": d,
                        "letter": d[0],
                        "total": usage.total,
                        "free": usage.free,
                        "used": usage.used,
                    })
                except Exception:
                    continue
        except Exception as e:
            logging.warning(f"Failed to enumerate drives: {e}")
        self._json({"drives": drives})

    # ---- native file browse -------------------------------------------
    def handle_browse(self):
        body = self._read_body()
        mode = body.get("mode", "file")
        try:
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            paths = []
            if mode == "files":
                paths = list(filedialog.askopenfilenames() or [])
            elif mode == "folder":
                folder = filedialog.askdirectory()
                if folder:
                    for dirpath, _dirs, files in os.walk(folder):
                        for name in files:
                            paths.append(os.path.join(dirpath, name))
                            if len(paths) >= 1000:
                                break
                        if len(paths) >= 1000:
                            break
            else:
                single = filedialog.askopenfilename()
                if single:
                    paths = [single]
            root.destroy()
            self._json({"paths": paths})
        except Exception as e:
            logging.error(f"Error in browse dialog: {e}")
            self.send_error(500, str(e))

    # ---- cancel --------------------------------------------------------
    def handle_cancel(self):
        body = self._read_body()
        job_id = body.get("job_id")
        proc = None
        with JOBS_LOCK:
            job = ACTIVE_JOBS.get(job_id)
            if job:
                job["cancel"] = True
                proc = job.get("proc")
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
        logging.info(f"Cancel requested for job {job_id}")
        self._json({"ok": True, "job_id": job_id})

    # ---- one file wipe -------------------------------------------------
    def _wipe_one(self, item, passes, job_id, file_index, file_total):
        path = item["path"]
        is_ssd = bool(item.get("is_ssd"))
        filename = os.path.basename(path)
        size = os.path.getsize(path)
        total_passes = 1 if is_ssd else max(1, passes)
        total_work = max(1, size * total_passes)

        self._sse({"type": "file_start", "file_index": file_index, "file_total": file_total,
                   "filename": filename, "size": size,
                   "message": f"[{file_index}/{file_total}] Target locked: {filename} ({size} bytes)"})

        sha = sha256_of_file(path)
        with open(path, "rb") as f:
            orig_data = f.read(512)
        orig_hex = format_hex_data(orig_data)

        start = time.time()
        work_before = 0
        last_emit = 0.0
        passes_completed = 0

        def base_progress():
            return (file_index - 1) / file_total

        for p in range(1, total_passes + 1):
            if is_cancelled(job_id):
                break
            if is_ssd:
                fill = lambda n: b"\x00" * n
                msg = "SSD mode: zero-filling logical blocks (pass 1/1)..."
            elif p == 1:
                fill = lambda n: b"\xFF" * n
                msg = f"Pass {p}/{total_passes}: writing 0xFF (ones)..."
            elif p == 2:
                fill = lambda n: b"\x00" * n
                msg = f"Pass {p}/{total_passes}: writing 0x00 (zeroes)..."
            else:
                fill = os.urandom
                msg = f"Pass {p}/{total_passes}: writing cryptographic random..."
            self._sse({"type": "progress", "file_index": file_index, "file_total": file_total,
                       "filename": filename, "pass": p, "passes": total_passes,
                       "message": msg, "progress": base_progress() + (work_before / total_work) / file_total,
                       "speed_mbps": 0, "eta_seconds": None})

            def on_progress(done_this_pass):
                nonlocal last_emit
                now = time.time()
                if now - last_emit < 0.12:
                    return
                last_emit = now
                total_done = work_before + done_this_pass
                elapsed = now - start
                speed = (total_done / elapsed) if elapsed > 0 else 0
                remaining_bytes = total_work - total_done
                eta = (remaining_bytes / speed) if speed > 0 else None
                file_frac = total_done / total_work
                self._sse({"type": "progress", "file_index": file_index, "file_total": file_total,
                           "filename": filename, "pass": p, "passes": total_passes, "message": None,
                           "progress": base_progress() + file_frac / file_total,
                           "file_progress": file_frac,
                           "speed_mbps": round(speed / 1048576, 2),
                           "eta_seconds": round(eta) if eta is not None else None})

            written = overwrite_file(path, size, fill, job_id=job_id, on_progress=on_progress)
            work_before += size
            if is_cancelled(job_id) and written < size:
                break
            passes_completed = p
            time.sleep(0.12)

        if is_cancelled(job_id):
            return {"cancelled": True, "passes_completed": passes_completed, "filename": filename}

        # Native SSD purge: TRIM the volume so the flash controller drops the pages.
        if is_ssd:
            drive_letter = os.path.splitdrive(path)[0].rstrip(":")
            self._sse({"type": "progress", "file_index": file_index, "file_total": file_total,
                       "filename": filename, "message": f"Native TRIM: Optimize-Volume -DriveLetter {drive_letter} -ReTrim...",
                       "progress": base_progress() + 0.85 / file_total})
            try:
                res = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     f"Optimize-Volume -DriveLetter {drive_letter} -ReTrim -ErrorAction Stop"],
                    capture_output=True, text=True, timeout=120)
                if res.returncode == 0:
                    self._sse({"type": "progress", "filename": filename,
                               "message": "Native TRIM completed: unmapped pages purged by controller."})
                else:
                    self._sse({"type": "progress", "filename": filename,
                               "message": "TRIM needs admin rights; run Optimize-Volume manually to finish SSD purge."})
            except Exception as te:
                self._sse({"type": "progress", "filename": filename,
                           "message": f"TRIM step skipped ({te}); run Optimize-Volume manually."})

        # Verification read-back
        with open(path, "rb") as f:
            wiped_data = f.read(512)
        wiped_hex = format_hex_data(wiped_data)
        verified = (len(orig_data) == 0) or (wiped_data != orig_data)

        # Metadata obfuscation: rename -> truncate -> unlink
        parent = os.path.dirname(path)
        rand_name = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=16))
        temp_path = os.path.join(parent, rand_name)
        try:
            os.rename(path, temp_path)
            with open(temp_path, "wb") as f:
                f.truncate(0)
            os.remove(temp_path)
        except Exception as de:
            logging.warning(f"Metadata obfuscation partial for {path}: {de}")

        method = ("SSD zero-fill + native TRIM (Optimize-Volume ReTrim)" if is_ssd
                  else f"HDD {total_passes}-pass overwrite (0xFF / 0x00 / random)")
        record = {
            "filename": filename, "path": path, "size": size, "sha256": sha,
            "method": method, "passes": total_passes, "verified": verified,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
        }
        self._sse({"type": "file_done", "file_index": file_index, "file_total": file_total,
                   "filename": filename, "verified": verified, "record": record,
                   "original_hex": orig_hex, "wiped_hex": wiped_hex,
                   "message": f"[{file_index}/{file_total}] {filename} shredded and unlinked."})
        return {"cancelled": False, "record": record, "verified": verified}

    def handle_erase(self):
        body = self._read_body()
        passes = int(body.get("passes", 3))
        job_id = body.get("job_id")

        items = body.get("items")
        if not items:
            single = body.get("path")
            if single:
                items = [{"path": single, "is_ssd": bool(body.get("is_ssd"))}]
        items = items or []
        items = [it for it in items if it.get("path") and os.path.isfile(it["path"])]
        if not items:
            return self._json({"detail": "No existing files to erase"}, 404)

        register_job(job_id)
        self._sse_start()
        records = []
        try:
            total = len(items)
            for idx, item in enumerate(items, 1):
                if is_cancelled(job_id):
                    break
                logging.info(f"Erasing {item['path']} (SSD={item.get('is_ssd')}, passes={passes})")
                result = self._wipe_one(item, passes, job_id, idx, total)
                if result.get("cancelled"):
                    self._sse({"type": "cancelled",
                               "message": f"Wipe cancelled. {len(records)} of {total} files completed; "
                                          f"{result.get('passes_completed', 0)} passes done on the current file.",
                               "records": records})
                    return
                if result.get("record"):
                    records.append(result["record"])
            if is_cancelled(job_id):
                self._sse({"type": "cancelled",
                           "message": f"Wipe cancelled. {len(records)} of {total} files completed.",
                           "records": records})
            else:
                self._sse({"type": "completed", "progress": 1.0, "records": records,
                           "message": f"Done. {len(records)} file(s) securely erased."})
        except Exception as e:
            logging.error(f"Erase error: {e}")
            try:
                self._sse({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            unregister_job(job_id)

    # ---- free-space wipe (native cipher /w) ---------------------------
    def handle_wipe_free_space(self):
        body = self._read_body()
        drive = body.get("drive", "C:\\")
        job_id = body.get("job_id")
        if not os.path.exists(drive):
            return self._json({"detail": "Drive not found"}, 404)

        register_job(job_id)
        self._sse_start()
        try:
            self._sse({"type": "progress", "message": f"Launching native free-space wipe: cipher /w:{drive}",
                       "progress": 0.02})
            proc = subprocess.Popen(
                ["cipher", f"/w:{drive}"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, universal_newlines=True)
            attach_proc(job_id, proc)

            dots = 0
            for chunk in iter(lambda: proc.stdout.read(80), ""):
                if is_cancelled(job_id):
                    proc.terminate()
                    self._sse({"type": "cancelled", "message": "Free-space wipe cancelled by user."})
                    return
                text = chunk.strip()
                if not text:
                    continue
                dots += text.count(".")
                # cipher writes three phases (0x00, 0xFF, random) as dot streams
                phase = min(0.95, 0.05 + (dots % 300) / 300 * 0.9)
                self._sse({"type": "progress", "message": text[:120], "progress": phase})
            proc.wait()
            if is_cancelled(job_id):
                self._sse({"type": "cancelled", "message": "Free-space wipe cancelled."})
            elif proc.returncode == 0:
                self._sse({"type": "completed", "progress": 1.0, "records": [],
                           "message": f"Free space on {drive} securely wiped (0x00, 0xFF, random passes)."})
            else:
                self._sse({"type": "error", "message": f"cipher exited with code {proc.returncode}."})
        except FileNotFoundError:
            self._sse({"type": "error", "message": "cipher.exe not found (Windows only feature)."})
        except Exception as e:
            logging.error(f"Free-space wipe error: {e}")
            try:
                self._sse({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            unregister_job(job_id)

    # ---- certificate download -----------------------------------------
    def handle_certificate(self):
        body = self._read_body()
        records = body.get("records", [])
        fmt = (body.get("format") or "json").lower()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        try:
            if fmt == "pdf":
                data = build_certificate_pdf(records)
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Disposition", f'attachment; filename="erasure-certificate-{stamp}.pdf"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                data = build_certificate_json(records)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Disposition", f'attachment; filename="erasure-certificate-{stamp}.json"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            logging.error(f"Certificate error: {e}")
            self.send_error(500, str(e))


def run_server(port=8999):
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, SecureEraserRequestHandler)
    logging.info(f"Local Server started at http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        logging.info("Server stopped.")


if __name__ == "__main__":
    run_server(port=8999)
