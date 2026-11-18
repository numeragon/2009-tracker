export function ProfileSkeleton() {
  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      {/* Header skeleton */}
      <div className="vt-panel p-6">
        <div className="flex items-center gap-5">
          <div className="w-20 h-20 rounded-[12px] vt-skeleton shrink-0" />
          <div className="space-y-2.5 flex-1">
            <div className="h-6 w-52 vt-skeleton" />
            <div className="h-4 w-32 vt-skeleton" />
          </div>
          <div className="h-9 w-24 vt-skeleton rounded-[12px]" />
        </div>
      </div>

      {/* Ranks + Season row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="vt-panel p-5 space-y-3">
          <div className="h-3.5 w-20 vt-skeleton" />
          <div className="flex items-center gap-3.5 pt-1">
            <div className="w-12 h-12 rounded-full vt-skeleton" />
            <div className="space-y-2">
              <div className="h-5 w-28 vt-skeleton" />
              <div className="h-3.5 w-16 vt-skeleton" />
            </div>
          </div>
        </div>
        <div className="vt-panel p-5 space-y-3">
          <div className="h-3.5 w-20 vt-skeleton" />
          <div className="flex items-center gap-3.5 pt-1">
            <div className="w-12 h-12 rounded-full vt-skeleton" />
            <div className="space-y-2">
              <div className="h-5 w-28 vt-skeleton" />
              <div className="h-3.5 w-16 vt-skeleton" />
            </div>
          </div>
        </div>
        <div className="vt-panel p-5 space-y-3">
          <div className="h-3.5 w-24 vt-skeleton" />
          <div className="h-7 w-24 vt-skeleton mt-2" />
          <div className="h-3.5 w-32 vt-skeleton" />
        </div>
      </div>

      {/* Stats grid */}
      <div className="vt-panel p-6 space-y-4">
        <div className="h-4 w-48 vt-skeleton" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-2">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="space-y-2">
              <div className="h-3 w-14 vt-skeleton" />
              <div className="h-6 w-20 vt-skeleton" />
            </div>
          ))}
        </div>
      </div>

      {/* Chart skeleton */}
      <div className="vt-panel p-6 space-y-4">
        <div className="h-4 w-36 vt-skeleton" />
        <div className="h-52 w-full vt-skeleton rounded-[12px]" />
      </div>
    </div>
  );
}

export function MatchListSkeleton() {
  return (
    <div className="space-y-2.5 vt-animate-in">
      {Array.from({ length: 6 }).map((_, idx) => (
        <div key={idx} className="vt-panel p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-[10px] vt-skeleton shrink-0" />
            <div className="space-y-2">
              <div className="h-4 w-28 vt-skeleton" />
              <div className="h-3 w-20 vt-skeleton" />
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="h-5 w-16 vt-skeleton" />
            <div className="h-5 w-20 vt-skeleton" />
            <div className="h-4 w-14 vt-skeleton" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function MatchDetailSkeleton() {
  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      <div className="h-8 w-32 vt-skeleton" />
      <div className="vt-panel p-6 space-y-3">
        <div className="h-6 w-48 vt-skeleton" />
        <div className="h-4 w-64 vt-skeleton" />
      </div>
      <div className="vt-panel p-6 space-y-3">
        {Array.from({ length: 10 }).map((_, idx) => (
          <div key={idx} className="h-10 w-full vt-skeleton" />
        ))}
      </div>
    </div>
  );
}
