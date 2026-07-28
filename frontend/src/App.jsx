import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";
import {
  browse, fileInfo, listDrives, cancelJob, eraseRequest, freeSpaceRequest,
  readSSE, downloadCertificate, newJobId, formatBytes,
} from "./api";
import HexInspector from "./components/HexInspector";
import FileQueue from "./components/FileQueue";
import ConfirmModal from "./components/ConfirmModal";

function fmtEta(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 1) return "0s";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function App() {
  const [mode, setMode] = useState("shred"); // "shred" | "freespace"

  // shred state
  const [queue, setQueue] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [passes, setPasses] = useState(7);
  const [snapshots, setSnapshots] = useState({}); // path -> { original, wiped }
  const [records, setRecords] = useState([]);

  // free-space state
  const [drives, setDrives] = useState([]);
  const [selectedDrive, setSelectedDrive] = useState("");

  // shared run state
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [overall, setOverall] = useState(0);
  const [stats, setStats] = useState({ pass: 0, passes: 0, speed: 0, eta: null, file: "" });
  const [logs, setLogs] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [modal, setModal] = useState({ open: false });

  const consoleEndRef = useRef(null);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (mode === "freespace" && drives.length === 0) {
      listDrives().then((d) => {
        setDrives(d);
        if (d.length) setSelectedDrive(d[0].drive);
      }).catch((e) => addLog(`Could not list drives: ${e.message}`, "error"));
    }
  }, [mode, drives.length]);

  const addLog = useCallback((text, type = "info") => {
    setLogs((prev) => [...prev, { text, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  // ---- queue management ----------------------------------------------
  const addPaths = useCallback(async (paths) => {
    const existing = new Set(queue.map((q) => q.path));
    const fresh = paths.filter((p) => p && !existing.has(p));
    if (fresh.length === 0) return;
    const stubs = fresh.map((p) => ({
      path: p, filename: p.split(/[\\/]/).pop(), size: 0,
      media_type: "", drive: "", status: "queued", progress: 0,
    }));
    setQueue((prev) => {
      const next = [...prev, ...stubs];
      if (selectedIndex === -1) setSelectedIndex(prev.length);
      return next;
    });
    addLog(`Added ${fresh.length} file(s) to the queue.`, "success");
    for (const p of fresh) {
      try {
        const info = await fileInfo(p);
        setQueue((prev) => prev.map((it) => it.path === p
          ? { ...it, size: info.size, media_type: info.media_type, drive: info.drive } : it));
      } catch (e) {
        setQueue((prev) => prev.map((it) => it.path === p ? { ...it, status: "error" } : it));
        addLog(`${p}: ${e.message}`, "error");
      }
    }
  }, [queue, selectedIndex, addLog]);

  const handleBrowse = async (m) => {
    if (busy) return;
    try {
      addLog(`Opening native ${m === "folder" ? "folder" : "file"} selector…`, "system");
      const paths = await browse(m);
      if (paths.length) addPaths(paths);
      else addLog("Selection canceled.", "system");
    } catch (e) {
      addLog(`Browser dialog failed: ${e.message}`, "error");
    }
  };

  const removeItem = (i) => {
    setQueue((prev) => prev.filter((_, idx) => idx !== i));
    setSelectedIndex((cur) => (cur === i ? -1 : cur > i ? cur - 1 : cur));
  };

  // ---- drag & drop ----------------------------------------------------
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) addPaths(paths);
    else {
      addLog("Browser hides dropped file paths — opening native picker instead.", "system");
      handleBrowse("files");
    }
  };

  const onDropKey = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleBrowse("files"); }
  };

  // ---- SSE event handling --------------------------------------------
  const applyEvent = useCallback((ev) => {
    if (ev.message) addLog(ev.message, ev.type === "error" ? "error" : ev.type === "cancelled" ? "warning" : "info");
    if (typeof ev.progress === "number") setOverall(ev.progress);

    if (ev.type === "file_start") {
      setStats((s) => ({ ...s, file: ev.filename, pass: 0, passes: 0, speed: 0, eta: null }));
      setQueue((prev) => prev.map((it, i) => i === ev.file_index - 1 ? { ...it, status: "running", progress: 0 } : it));
    } else if (ev.type === "progress") {
      setStats((s) => ({
        file: ev.filename || s.file,
        pass: ev.pass || s.pass,
        passes: ev.passes || s.passes,
        speed: ev.speed_mbps != null ? ev.speed_mbps : s.speed,
        eta: ev.eta_seconds !== undefined ? ev.eta_seconds : s.eta,
      }));
      if (ev.file_index && ev.file_progress != null) {
        setQueue((prev) => prev.map((it, i) => i === ev.file_index - 1 ? { ...it, progress: ev.file_progress } : it));
      }
    } else if (ev.type === "file_done") {
      setSnapshots((prev) => ({ ...prev, [ev.record?.path]: { original: ev.original_hex, wiped: ev.wiped_hex } }));
      setQueue((prev) => prev.map((it, i) => i === ev.file_index - 1 ? { ...it, status: "done", progress: 1 } : it));
      if (ev.record) setRecords((prev) => [...prev, ev.record]);
      addLog(ev.verified
        ? `Verified: ${ev.filename} sectors no longer match original data.`
        : `Warning: ${ev.filename} read-back still matches original bytes.`,
        ev.verified ? "success" : "warning");
    } else if (ev.type === "completed") {
      setOverall(1);
      if (ev.records) setRecords(ev.records);
    } else if (ev.type === "cancelled") {
      setQueue((prev) => prev.map((it) => it.status === "running" ? { ...it, status: "cancelled" } : it));
      if (ev.records) setRecords(ev.records);
    }
  }, [addLog]);

  // ---- shred flow -----------------------------------------------------
  const startErase = async () => {
    const targets = queue.filter((q) => q.status === "queued" || q.status === "error");
    if (targets.length === 0) return;
    const id = newJobId();
    setJobId(id); setBusy(true); setOverall(0); setRecords([]);
    setStats({ pass: 0, passes: 0, speed: 0, eta: null, file: "" });
    setLogs([]);
    addLog(`Initiating secure erasure of ${queue.length} file(s)…`, "warning");
    try {
      const items = queue.map((q) => ({ path: q.path, is_ssd: q.media_type === "SSD" }));
      const res = await eraseRequest({ items, passes, job_id: id });
      if (!res.ok) throw new Error("Failed to start erase service");
      await readSSE(res, applyEvent);
    } catch (e) {
      addLog(`Erase interrupted: ${e.message}`, "error");
    } finally {
      setBusy(false); setJobId(null);
    }
  };

  const requestErase = () => {
    if (busy) return;
    const active = queue.filter((q) => q.status === "queued" || q.status === "error");
    if (active.length === 0) return;
    const single = active.length === 1;
    setModal({
      open: true,
      phrase: single ? active[0].filename : "ERASE ALL",
      title: "Permanent, irreversible erase",
      body: single
        ? `You are about to shred and delete "${active[0].filename}". This cannot be undone.`
        : `You are about to shred and delete ${active.length} files. This cannot be undone.`,
      onConfirm: () => { setModal({ open: false }); startErase(); },
    });
  };

  // ---- free-space flow ------------------------------------------------
  const startFreeSpace = async () => {
    if (!selectedDrive) return;
    const id = newJobId();
    setJobId(id); setBusy(true); setOverall(0); setLogs([]);
    addLog(`Starting native free-space wipe on ${selectedDrive}…`, "warning");
    try {
      const res = await freeSpaceRequest({ drive: selectedDrive, job_id: id });
      if (!res.ok) throw new Error("Failed to start free-space wipe");
      await readSSE(res, applyEvent);
    } catch (e) {
      addLog(`Free-space wipe interrupted: ${e.message}`, "error");
    } finally {
      setBusy(false); setJobId(null);
    }
  };

  const requestFreeSpace = () => {
    if (busy || !selectedDrive) return;
    setModal({
      open: true,
      phrase: "WIPE FREE SPACE",
      title: `Wipe free space on ${selectedDrive}`,
      body: "This overwrites all unallocated space with 0x00, 0xFF, and random data using the native Windows cipher tool. Existing files are untouched, but it may take a long time.",
      onConfirm: () => { setModal({ open: false }); startFreeSpace(); },
    });
  };

  const handleCancel = () => {
    if (jobId) { cancelJob(jobId); addLog("Cancel signal sent to server…", "warning"); }
  };

  // ---- derived --------------------------------------------------------
  const selected = selectedIndex >= 0 ? queue[selectedIndex] : null;
  const inspectorPath = selected && selected.status !== "done" && selected.status !== "cancelled" ? selected.path : null;
  const inspectorSnap = selected ? snapshots[selected.path] : null;
  const pendingCount = queue.filter((q) => q.status === "queued" || q.status === "error").length;
  const anySsd = queue.some((q) => q.media_type === "SSD");

  return (
    <div className="App">
      <header className="app-header">
        <div className="logo-badge" aria-hidden="true"><span>🛡</span></div>
        <h1 className="title-gradient">File Eraser X1</h1>
        <p className="subtitle">Secure, non-recoverable file destruction with live byte analytics, hidden-message inspection, and hardware-aware sanitization.</p>
        <div className="mode-tabs" role="tablist">
          <button role="tab" aria-selected={mode === "shred"} className={`mode-tab ${mode === "shred" ? "active" : ""}`} onClick={() => !busy && setMode("shred")}>
            🔥 Shred files
          </button>
          <button role="tab" aria-selected={mode === "freespace"} className={`mode-tab ${mode === "freespace" ? "active" : ""}`} onClick={() => !busy && setMode("freespace")}>
            🧹 Free-space wipe
          </button>
        </div>
      </header>

      <main className="dashboard-container">
        {/* LEFT COLUMN */}
        <section className="glass-panel panel-section accent-left animate-fade-in">
          {mode === "shred" ? (
            <>
              <h2 className="panel-title">Target &amp; configuration</h2>

              <div
                className={`dropzone ${dragOver ? "drag-over" : ""}`}
                role="button"
                tabIndex={0}
                aria-label="Add files to erase — activates the native file picker"
                onClick={() => handleBrowse("files")}
                onKeyDown={onDropKey}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                <div className="dropzone-icon">📁</div>
                <div className="dropzone-text">{dragOver ? "Release to add files" : "Drag files here, or click to browse"}</div>
                <div className="dropzone-hint">Multi-select supported · keyboard accessible</div>
              </div>

              <div className="btn-row">
                <button className="btn-secondary" disabled={busy} onClick={() => handleBrowse("files")}>+ Add files</button>
                <button className="btn-secondary" disabled={busy} onClick={() => handleBrowse("folder")}>+ Add folder</button>
                {queue.length > 0 && !busy && (
                  <button className="btn-ghost" onClick={() => { setQueue([]); setSelectedIndex(-1); setRecords([]); }}>Clear</button>
                )}
              </div>

              <FileQueue
                items={queue}
                selectedIndex={selectedIndex}
                onSelect={setSelectedIndex}
                onRemove={removeItem}
                disabled={busy}
              />

              {anySsd && (
                <div className="ssd-info-box animate-fade-in">
                  <strong>SSD detected:</strong> wear-leveling means in-place overwrite isn't guaranteed. SSD files get a zero-fill plus a native TRIM (Optimize-Volume ReTrim) to purge unmapped pages.
                </div>
              )}

              {/* passes */}
              <div className="setting-group">
                <div className="setting-label">
                  <span>Secure passes (HDD)</span>
                  <span className="pass-count">{passes}</span>
                </div>
                <input type="range" min="1" max="35" step="1" value={passes}
                  onChange={(e) => setPasses(parseInt(e.target.value))}
                  disabled={busy} className="slider-input" />
                <span className="hint-text">
                  {passes <= 3 ? "Quick shred (fast, lower assurance)"
                    : passes <= 7 ? "DoD 5220.22-M class (standard secure)"
                      : "Gutmann class (maximum assurance)"}
                </span>
              </div>

              {/* live stats */}
              {busy && (
                <div className="stats-grid animate-fade-in">
                  <div className="stat-tile"><span className="stat-label">Pass</span><span className="stat-value">{stats.pass}/{stats.passes || "—"}</span></div>
                  <div className="stat-tile"><span className="stat-label">Speed</span><span className="stat-value">{stats.speed || 0} <small>MB/s</small></span></div>
                  <div className="stat-tile"><span className="stat-label">ETA</span><span className="stat-value">{fmtEta(stats.eta)}</span></div>
                </div>
              )}

              {busy && (
                <div className="flex flex-col gap-2 animate-fade-in">
                  <div className="setting-label"><span className="ellipsis">{stats.file || "Working…"}</span><span>{Math.round(overall * 100)}%</span></div>
                  <div className="shred-progress-bar-container"><div className="shred-progress-fill" style={{ width: `${overall * 100}%` }} /></div>
                </div>
              )}

              {busy ? (
                <button className="btn-cancel w-full" onClick={handleCancel} style={{ padding: "1rem" }}>
                  <span className="pulse-spinner" /> STOP &amp; CANCEL
                </button>
              ) : (
                <button className="btn-danger w-full" disabled={pendingCount === 0}
                  onClick={requestErase}
                  style={{ padding: "1rem", fontSize: "1.05rem", opacity: pendingCount === 0 ? 0.4 : 1, cursor: pendingCount === 0 ? "not-allowed" : "pointer" }}>
                  🔥 SHRED {pendingCount > 1 ? `${pendingCount} FILES` : "FILE"} PERMANENTLY
                </button>
              )}

              {records.length > 0 && !busy && (
                <div className="cert-card animate-fade-in">
                  <div className="cert-head"><span className="cert-icon">📜</span><strong>Erasure certificate ready</strong></div>
                  <p className="cert-sub">{records.length} file(s) with SHA-256 hashes, method, and timestamps.</p>
                  <div className="btn-row">
                    <button className="btn-primary" onClick={() => downloadCertificate(records, "pdf")}>Download PDF</button>
                    <button className="btn-secondary" onClick={() => downloadCertificate(records, "json")}>Download JSON</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* FREE-SPACE MODE */
            <>
              <h2 className="panel-title">Free-space wipe</h2>
              <p className="hint-text">Overwrite unallocated space so previously deleted files can't be carved back. Uses the native Windows <code>cipher /w</code> (0x00, 0xFF, random).</p>

              <div className="setting-group">
                <div className="setting-label"><span>Target drive</span></div>
                <select className="drive-select" value={selectedDrive} disabled={busy}
                  onChange={(e) => setSelectedDrive(e.target.value)}>
                  {drives.length === 0 && <option value="">Loading drives…</option>}
                  {drives.map((d) => (
                    <option key={d.drive} value={d.drive}>
                      {d.drive} — {formatBytes(d.free)} free of {formatBytes(d.total)}
                    </option>
                  ))}
                </select>
              </div>

              {selectedDrive && drives.find((d) => d.drive === selectedDrive) && (
                <div className="stats-grid animate-fade-in">
                  {(() => { const d = drives.find((x) => x.drive === selectedDrive); const pct = d.total ? Math.round((d.used / d.total) * 100) : 0; return (
                    <>
                      <div className="stat-tile"><span className="stat-label">Free</span><span className="stat-value">{formatBytes(d.free)}</span></div>
                      <div className="stat-tile"><span className="stat-label">Used</span><span className="stat-value">{pct}%</span></div>
                      <div className="stat-tile"><span className="stat-label">Total</span><span className="stat-value">{formatBytes(d.total)}</span></div>
                    </>
                  ); })()}
                </div>
              )}

              {busy && (
                <div className="flex flex-col gap-2 animate-fade-in">
                  <div className="setting-label"><span>Wiping free space…</span><span>{Math.round(overall * 100)}%</span></div>
                  <div className="shred-progress-bar-container"><div className="shred-progress-fill" style={{ width: `${overall * 100}%` }} /></div>
                </div>
              )}

              {busy ? (
                <button className="btn-cancel w-full" onClick={handleCancel} style={{ padding: "1rem" }}><span className="pulse-spinner" /> STOP &amp; CANCEL</button>
              ) : (
                <button className="btn-danger w-full" disabled={!selectedDrive} onClick={requestFreeSpace}
                  style={{ padding: "1rem", opacity: selectedDrive ? 1 : 0.4 }}>🧹 WIPE FREE SPACE</button>
              )}
            </>
          )}
        </section>

        {/* RIGHT COLUMN */}
        <section className="flex flex-col gap-4">
          {mode === "shred" && (
            <div className="glass-panel panel-section accent-cyan" style={{ flexGrow: 0 }}>
              <div className="flex justify-between items-center panel-title-row">
                <h2 className="panel-title inline-title">Binary footprint</h2>
                {selected && <span className="inspect-name">{selected.filename}</span>}
              </div>
              <HexInspector path={inspectorPath} snapshot={inspectorSnap} onLog={addLog} />
            </div>
          )}

          <div className="glass-panel panel-section accent-violet" style={{ flexGrow: 1 }}>
            <h2 className="panel-title">Diagnostics console</h2>
            <div className="console-panel">
              {logs.length === 0 ? (
                <div className="console-empty">Awaiting instructions…</div>
              ) : logs.map((log, i) => (
                <div key={i} className={`console-line ${log.type}`}>
                  <span className="console-time">[{log.time}] </span><span>{log.text}</span>
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          </div>
        </section>
      </main>

      <ConfirmModal
        open={modal.open}
        phrase={modal.phrase}
        title={modal.title}
        body={modal.body}
        onConfirm={modal.onConfirm}
        onCancel={() => setModal({ open: false })}
      />
    </div>
  );
}
