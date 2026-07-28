export const API_BASE = "http://127.0.0.1:8999";

export function newJobId() {
  return "job-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

export async function browse(mode = "file") {
  const res = await fetch(`${API_BASE}/api/browse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const data = await res.json();
  return data.paths || [];
}

export async function fileInfo(path) {
  const res = await fetch(`${API_BASE}/api/file-info?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to load file details");
  }
  return res.json();
}

export async function hexData(path, offset = 0, length = 512) {
  const res = await fetch(
    `${API_BASE}/api/hex-data?path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`
  );
  if (!res.ok) throw new Error("Failed to load binary structure");
  return res.json();
}

export async function stringsData(path, min = 4) {
  const res = await fetch(`${API_BASE}/api/strings?path=${encodeURIComponent(path)}&min=${min}`);
  if (!res.ok) throw new Error("Failed to scan for strings");
  return res.json();
}

export async function listDrives() {
  const res = await fetch(`${API_BASE}/api/drives`);
  if (!res.ok) throw new Error("Failed to list drives");
  const data = await res.json();
  return data.drives || [];
}

export async function cancelJob(jobId) {
  try {
    await fetch(`${API_BASE}/api/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
  } catch {
    /* best-effort */
  }
}

export function eraseRequest(body) {
  return fetch(`${API_BASE}/api/erase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function freeSpaceRequest(body) {
  return fetch(`${API_BASE}/api/wipe-free-space`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Reads a fetch Response streamed as SSE, invoking onEvent(parsedJson) per event.
export async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const line of parts) {
      if (line.startsWith("data: ")) {
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* ignore partial payloads */
        }
      }
    }
  }
}

export async function downloadCertificate(records, format) {
  const res = await fetch(`${API_BASE}/api/certificate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records, format }),
  });
  if (!res.ok) throw new Error("Failed to build certificate");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `erasure-certificate.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
