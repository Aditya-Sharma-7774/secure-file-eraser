import React, { useState, useEffect, useCallback } from "react";
import { hexData, stringsData, formatBytes } from "../api";

const PAGE = 512;

/**
 * Binary footprint inspector. Views:
 *  - hex     : classic offset / hex / ASCII dump (paginated across the file)
 *  - binary  : same bytes rendered as 8-bit binary (bit-level inspection)
 *  - strings : printable ASCII runs with offsets — reveals hidden messages
 *  - wiped   : post-shred read-back
 *
 * `path` drives live inspection of an existing file. Once a file is erased it
 * no longer exists on disk, so `snapshot` ({ original, wiped }) supplies the
 * captured before/after rows instead.
 */
export default function HexInspector({ path, snapshot, onLog }) {
  const [view, setView] = useState("hex");
  const [rows, setRows] = useState(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [strings, setStrings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const live = !!path;
  const wiped = snapshot?.wiped || null;

  const loadHex = useCallback(async (p, off) => {
    if (!p) return;
    setLoading(true); setError(null);
    try {
      const d = await hexData(p, off, PAGE);
      setRows(d.hex_rows); setOffset(d.offset); setTotal(d.total_size);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStrings = useCallback(async (p) => {
    if (!p) return;
    setLoading(true); setError(null);
    try {
      const d = await stringsData(p, 4);
      setStrings(d.strings);
      onLog?.(`String scan found ${d.count} readable run(s) — check for hidden text.`, "info");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  useEffect(() => {
    setView("hex"); setStrings(null); setOffset(0); setError(null);
    if (path) loadHex(path, 0);
    else { setRows(null); setTotal(0); }
  }, [path, snapshot, loadHex]);

  useEffect(() => {
    if (view === "strings" && strings === null && live) loadStrings(path);
  }, [view, strings, live, path, loadStrings]);

  const showWiped = view === "wiped" && wiped;
  const baseRows = live ? rows : (snapshot?.original || null);
  const activeRows = showWiped ? wiped : baseRows;
  const canPage = live && (view === "hex" || view === "binary");
  const pageEnd = Math.min(offset + PAGE, total);

  const tabs = [
    { id: "hex", label: "Hex" },
    { id: "binary", label: "Binary" },
    { id: "strings", label: "Strings" },
  ];
  if (wiped) tabs.push({ id: "wiped", label: "Wiped" });

  return (
    <>
      <div className="hex-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`hex-tab ${view === t.id ? "active" : ""}`}
            onClick={() => setView(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {canPage && total > 0 && (
        <div className="hex-pager">
          <button className="pager-btn" disabled={offset === 0} onClick={() => loadHex(path, Math.max(0, offset - PAGE))}>◀ Prev</button>
          <span className="pager-info">
            0x{offset.toString(16).toUpperCase().padStart(8, "0")} – 0x{pageEnd.toString(16).toUpperCase().padStart(8, "0")} of {formatBytes(total)}
          </span>
          <button className="pager-btn" disabled={pageEnd >= total} onClick={() => loadHex(path, offset + PAGE)}>Next ▶</button>
        </div>
      )}

      <div className="hex-container">
        {loading ? (
          <div className="hex-placeholder">Reading sectors…</div>
        ) : error ? (
          <div className="hex-placeholder" style={{ color: "var(--danger)" }}>{error}</div>
        ) : view === "strings" ? (
          !live ? (
            <div className="hex-placeholder">This file has been erased — string scanning is only available before shredding.</div>
          ) : strings && strings.length > 0 ? (
            <table className="hex-table animate-fade-in">
              <thead>
                <tr className="hex-header-row"><th>Offset</th><th>Readable text (possible hidden message)</th></tr>
              </thead>
              <tbody>
                {strings.map((s, i) => (
                  <tr key={i} className="hex-row-data">
                    <td className="hex-offset">{s.offset}</td>
                    <td className="hex-string-text">{s.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="hex-placeholder">No printable strings ≥ 4 chars found in the scanned region.</div>
          )
        ) : activeRows ? (
          <table className="hex-table animate-fade-in">
            <thead>
              <tr className="hex-header-row">
                <th>Offset</th>
                <th colSpan={view === "binary" ? 8 : 16}>{view === "binary" ? "Binary (bits)" : "Hex values"}</th>
                <th>ASCII</th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((row, r) => (
                <tr key={r} className="hex-row-data">
                  <td className="hex-offset" style={showWiped ? { color: "var(--success)" } : undefined}>{row.offset}</td>
                  {view === "binary"
                    ? row.bytes.slice(0, 8).map((b, i) => (
                        <td key={i} className="hex-binary-val">{b ? parseInt(b, 16).toString(2).padStart(8, "0") : ""}</td>
                      ))
                    : row.bytes.map((b, i) => (
                        <td key={i} className="hex-byte-val" style={showWiped ? { color: "var(--success)", opacity: b === "00" ? 0.4 : 1 } : undefined}>
                          {b || ".."}
                        </td>
                      ))}
                  <td className="hex-ascii-text" style={showWiped ? { color: "var(--success)" } : undefined}>{row.ascii}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hex-placeholder">
            Select a file to load its binary footprint. Use the Hex, Binary, and Strings views to inspect raw bytes and spot any hidden messages before erasing.
          </div>
        )}
      </div>
    </>
  );
}
