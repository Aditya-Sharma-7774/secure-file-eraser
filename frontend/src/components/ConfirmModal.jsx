import React, { useState, useEffect, useRef } from "react";

/**
 * Type-to-confirm gate. The user must type `phrase` exactly to unlock the
 * destructive action — a much stronger guard than a plain window.confirm().
 */
export default function ConfirmModal({ open, phrase, title, body, onConfirm, onCancel }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const matched = value.trim() === phrase;

  const onKeyDown = (e) => {
    if (e.key === "Enter" && matched) onConfirm();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card animate-pop" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-danger-icon">⚠</div>
        <h2 className="modal-title">{title}</h2>
        <p className="modal-body">{body}</p>
        <div className="modal-phrase-hint">
          Type <span className="modal-phrase">{phrase}</span> to confirm
        </div>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={phrase}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Confirmation phrase"
        />
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn-danger"
            disabled={!matched}
            style={{ opacity: matched ? 1 : 0.4, cursor: matched ? "pointer" : "not-allowed", padding: "0.6rem 1.2rem" }}
            onClick={() => matched && onConfirm()}
          >
            Erase permanently
          </button>
        </div>
      </div>
    </div>
  );
}
