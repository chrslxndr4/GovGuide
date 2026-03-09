import { useEffect, useRef, useState, lazy, Suspense } from 'react';

type GraphComponentName = 'MoneyGraph' | 'MoneyFlow';

interface LazyGraphProps {
  component: GraphComponentName;
  props: Record<string, unknown>;
  fallbackHeight?: string;
}

const COMPONENT_LOADERS: Record<GraphComponentName, () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>> = {
  MoneyGraph: () =>
    import('../graph/MoneyGraph') as Promise<{ default: React.ComponentType<Record<string, unknown>> }>,
  MoneyFlow: () =>
    import('../graph/MoneyFlow') as Promise<{ default: React.ComponentType<Record<string, unknown>> }>,
};

function GraphSkeleton({ height }: { height: string }) {
  return (
    <div
      role="status"
      aria-label="Loading visualization"
      className="w-full rounded-lg bg-slate-100 border border-slate-200 overflow-hidden"
      style={{ height }}
    >
      {/* Animated shimmer lines mimicking a graph canvas */}
      <div className="w-full h-full relative animate-pulse">
        <div className="absolute inset-0 bg-gradient-to-r from-slate-100 via-slate-50 to-slate-100" />

        {/* Fake node circles scattered around the canvas */}
        <div className="absolute top-1/4 left-1/3 w-10 h-10 rounded-full bg-slate-200" />
        <div className="absolute top-1/2 left-1/2 w-14 h-14 rounded-full bg-slate-200" />
        <div className="absolute top-1/3 left-2/3 w-8 h-8 rounded-full bg-slate-200" />
        <div className="absolute top-2/3 left-1/4 w-9 h-9 rounded-full bg-slate-200" />
        <div className="absolute top-1/5 left-3/5 w-7 h-7 rounded-full bg-slate-200" />

        {/* Fake edge lines */}
        <div className="absolute top-1/3 left-1/3 w-1/4 h-0.5 bg-slate-200 rotate-12" />
        <div className="absolute top-1/2 left-1/4 w-1/5 h-0.5 bg-slate-200 -rotate-6" />
        <div className="absolute top-2/5 left-1/2 w-1/6 h-0.5 bg-slate-200 rotate-3" />

        {/* Loading label */}
        <div className="absolute bottom-3 left-3 flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-slate-300 animate-bounce [animation-delay:0ms]" />
          <div className="w-3 h-3 rounded-full bg-slate-300 animate-bounce [animation-delay:150ms]" />
          <div className="w-3 h-3 rounded-full bg-slate-300 animate-bounce [animation-delay:300ms]" />
          <span className="text-xs text-slate-400 ml-1">Loading graph…</span>
        </div>
      </div>
      <span className="sr-only">Graph visualization is loading</span>
    </div>
  );
}

export default function LazyGraph({
  component,
  props,
  fallbackHeight = '400px',
}: LazyGraphProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [LoadedComponent, setLoadedComponent] =
    useState<React.ComponentType<Record<string, unknown>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Step 1: watch viewport intersection
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' } // start loading 200 px before it enters the viewport
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Step 2: dynamic import once in view
  useEffect(() => {
    if (!inView) return;

    const loader = COMPONENT_LOADERS[component];
    if (!loader) {
      setLoadError(`Unknown graph component: ${component}`);
      return;
    }

    let cancelled = false;

    loader()
      .then((mod) => {
        if (!cancelled) setLoadedComponent(() => mod.default);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : `Failed to load ${component}`
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inView, component]);

  if (loadError) {
    return (
      <div
        role="alert"
        className="w-full rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-600 text-sm px-4"
        style={{ height: fallbackHeight }}
      >
        {loadError}
      </div>
    );
  }

  return (
    <div ref={sentinelRef} className="w-full">
      {!LoadedComponent ? (
        <GraphSkeleton height={fallbackHeight} />
      ) : (
        <Suspense fallback={<GraphSkeleton height={fallbackHeight} />}>
          <LoadedComponent {...props} />
        </Suspense>
      )}
    </div>
  );
}
