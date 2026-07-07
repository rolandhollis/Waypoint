export function PhaseLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-wp-slate">
      <span className="font-medium">Phases</span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm bg-slate-500" /> Discovery / Definition
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-1 w-4 rounded"
          style={{
            backgroundColor: "#CBD5E1",
            backgroundImage: "repeating-linear-gradient(-45deg, #94a3b8 0 1.25px, transparent 1.25px 6px)",
          }}
        />
        Awaiting Dev
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="relative inline-block h-3 w-4 overflow-hidden rounded-sm bg-slate-500/55">
          <span
            className="absolute inset-0"
            style={{
              backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 2px, transparent 2px 6px)",
            }}
          />
        </span>
        Development
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-1 w-4 rounded"
          style={{
            backgroundColor: "#CBD5E1",
            backgroundImage: "repeating-linear-gradient(-45deg, #94a3b8 0 1.25px, transparent 1.25px 6px)",
          }}
        />
        Awaiting Optimization
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm bg-slate-500/25" /> Post-Dev Optimization
      </span>
    </div>
  );
}
