import React from "react";
import { formatBytes } from "../api";

const STATUS_META = {
  queued: { label: "Queued", cls: "st-queued" },
  running: { label: "Wiping", cls: "st-running" },
  done: { label: "Erased", cls: "st-done" },
  error: { label: "Error", cls: "st-error" },
  cancelled: { label: "Cancelled", cls: "st-cancelled" },
};

export default function FileQueue({ items, selectedIndex, onSelect, onRemove, disabled }) {
  if (items.length === 0) return null;

  return (
    <div className="queue-list">
      {items.map((item, i) => {
        const meta = STATUS_META[item.status] || STATUS_META.queued;
        const isSel = i === selectedIndex;
        return (
          <div
            key={item.path + i}
            className={`queue-item ${isSel ? "selected" : ""}`}
            onClick={() => onSelect(i)}
          >
            <div className="queue-item-main">
              <span className="queue-name" title={item.path}>{item.filename}</span>
              <div className="queue-meta">
                <span>{formatBytes(item.size)}</span>
                {item.media_type && (
                  <span className={`mini-badge ${item.media_type === "SSD" ? "mb-ssd" : item.media_type === "HDD" ? "mb-hdd" : "mb-un"}`}>
                    {item.media_type}
                  </span>
                )}
                <span className={`status-pill ${meta.cls}`}>{meta.label}</span>
              </div>
              {(item.status === "running" || item.status === "done") && (
                <div className="queue-progress">
                  <div className="queue-progress-fill" style={{ width: `${Math.round((item.progress || 0) * 100)}%` }} />
                </div>
              )}
            </div>
            {!disabled && item.status !== "running" && (
              <button
                className="queue-remove"
                aria-label={`Remove ${item.filename}`}
                onClick={(e) => { e.stopPropagation(); onRemove(i); }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
