import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";

export function UploadPanel({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: (f: File) => api.uploadStores(f),
    onSuccess: () => {
      setFile(null);
      if (input.current) input.current.value = "";
      return qc.invalidateQueries();
    },
  });
  const err = upload.error instanceof ApiError ? upload.error : null;

  return (
    <section className="card">
      <h2><span className="step">01</span> Upload store list</h2>
      <p className="muted">
        CSV with columns <code>store_id, store_name, address, city, state, country</code>.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) upload.mutate(file);
        }}
      >
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            upload.reset();
          }}
        />
        <button className="btn primary" disabled={!file || upload.isPending || disabled}>
          {upload.isPending ? "Uploading…" : "Start enrichment"}
        </button>
      </form>
      {disabled && <p className="muted small">A job is running. Wait for it to finish or cancel it.</p>}
      {err && (
        <div className="alert" role="alert">
          <strong>{err.message}</strong>
          {err.details.length > 0 && (
            <ul>
              {err.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
