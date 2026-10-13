export function PhaseLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-wp-slate">
      <span className="font-medium">Phases</span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm bg-slate-500/50" /> Discovery / Definition
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm border-[1.5px] border-slate-500 bg-transparent" />
        Awaiting (gap)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm bg-slate-500/70" /> Development
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm bg-slate-500" /> Post-Dev Optimization
      </span>
    </div>
  );
}
