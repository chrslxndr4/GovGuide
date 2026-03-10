import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import ScopeSwitcher, { type Scope } from '../ScopeSwitcher';
import 'maplibre-gl/dist/maplibre-gl.css';

const LAYER_CONFIG: Record<Scope, { sourceLayer: string; color: string; hoverColor: string; lineWidth: number }> = {
  federal:   { sourceLayer: 'states',    color: '#1B2A4A', hoverColor: '#2563EB', lineWidth: 2 },
  states:    { sourceLayer: 'states',    color: '#2563EB', hoverColor: '#1d4ed8', lineWidth: 2 },
  counties:  { sourceLayer: 'counties',  color: '#4A90E2', hoverColor: '#2563EB', lineWidth: 0.5 },
  cities:    { sourceLayer: 'places',    color: '#16A34A', hoverColor: '#15803D', lineWidth: 1 },
  districts: { sourceLayer: 'districts', color: '#D97706', hoverColor: '#b45309', lineWidth: 1 },
};

// Zoom level hints per scope
const SCOPE_ZOOM: Record<Scope, number> = {
  federal: 3.5,
  states: 3.5,
  counties: 5,
  cities: 8,
  districts: 5,
};

export default function GovMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoveredRef = useRef<{ id: number; layer: string } | null>(null);
  const [scope, setScope] = useState<Scope>('states');
  const [tooltip, setTooltip] = useState<{ name: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [{
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#F8FAFC' },
        }],
      },
      center: [-98.5, 39.8],
      zoom: 3.5,
      maxBounds: [[-180, 10], [-50, 75]],
    });

    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    map.on('load', () => {
      map.addSource('boundaries', {
        type: 'vector',
        url: 'pmtiles:///data/us-boundaries.pmtiles',
      });

      // Add all layers — only states visible initially
      Object.entries(LAYER_CONFIG).forEach(([scopeId, config]) => {
        const visible = scopeId === 'states';

        map.addLayer({
          id: `${scopeId}-fill`,
          type: 'fill',
          source: 'boundaries',
          'source-layer': config.sourceLayer,
          layout: { visibility: visible ? 'visible' : 'none' },
          paint: {
            'fill-color': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              config.hoverColor,
              config.color,
            ],
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0.8,
              0.6,
            ],
          },
        });

        map.addLayer({
          id: `${scopeId}-line`,
          type: 'line',
          source: 'boundaries',
          'source-layer': config.sourceLayer,
          layout: { visibility: visible ? 'visible' : 'none' },
          paint: {
            'line-color': '#ffffff',
            'line-width': config.lineWidth,
          },
        });
      });

      // Hover handlers
      const handleMouseMove = (layerScope: string) => (e: maplibregl.MapMouseEvent & { features?: maplibregl.GeoJSONFeature[] }) => {
        if (!e.features?.length) return;
        map.getCanvas().style.cursor = 'pointer';

        const config = LAYER_CONFIG[layerScope as Scope];
        const feature = e.features[0];
        const id = feature.id as number;

        // Show tooltip with name
        const name = feature.properties?.NAME || feature.properties?.NAMELSAD || '';
        if (name) {
          setTooltip({ name, x: e.point.x, y: e.point.y });
        }

        // Clear previous hover
        if (hoveredRef.current) {
          map.setFeatureState(
            { source: 'boundaries', sourceLayer: LAYER_CONFIG[hoveredRef.current.layer as Scope].sourceLayer, id: hoveredRef.current.id },
            { hover: false }
          );
        }

        map.setFeatureState(
          { source: 'boundaries', sourceLayer: config.sourceLayer, id },
          { hover: true }
        );
        hoveredRef.current = { id, layer: layerScope };
      };

      const handleMouseLeave = (layerScope: string) => () => {
        map.getCanvas().style.cursor = '';
        setTooltip(null);
        if (hoveredRef.current) {
          const config = LAYER_CONFIG[hoveredRef.current.layer as Scope];
          map.setFeatureState(
            { source: 'boundaries', sourceLayer: config.sourceLayer, id: hoveredRef.current.id },
            { hover: false }
          );
          hoveredRef.current = null;
        }
      };

      // Click handlers — navigate to detail pages
      map.on('click', 'states-fill', (e) => {
        if (!e.features?.length) return;
        const name = e.features[0].properties?.NAME;
        if (name) {
          const slug = name.toLowerCase().replace(/\s+/g, '-');
          window.location.href = `/states/${slug}`;
        }
      });

      map.on('click', 'counties-fill', (e) => {
        if (!e.features?.length) return;
        const props = e.features[0].properties;
        if (props?.NAME && props?.STATEFP) {
          const countySlug = props.NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          window.location.href = `/counties/${props.STATEFP}-${countySlug}`;
        }
      });

      map.on('click', 'cities-fill', (e) => {
        if (!e.features?.length) return;
        const props = e.features[0].properties;
        if (props?.NAME && props?.STATEFP) {
          const citySlug = props.NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          window.location.href = `/cities/${props.STATEFP}-${citySlug}`;
        }
      });

      map.on('click', 'districts-fill', (e) => {
        if (!e.features?.length) return;
        const props = e.features[0].properties;
        if (props?.CD118FP && props?.STATEFP) {
          window.location.href = `/federal/legislative?state=${props.STATEFP}&district=${props.CD118FP}`;
        }
      });

      // Register hover handlers for all interactive layers
      ['states', 'counties', 'cities', 'districts'].forEach(layerScope => {
        map.on('mousemove', `${layerScope}-fill`, handleMouseMove(layerScope));
        map.on('mouseleave', `${layerScope}-fill`, handleMouseLeave(layerScope));
      });
    });

    mapRef.current = map;
    return () => {
      maplibregl.removeProtocol('pmtiles');
      map.remove();
    };
  }, []);

  const handleScopeChange = useCallback((newScope: Scope) => {
    const map = mapRef.current;
    if (!map) return;

    Object.keys(LAYER_CONFIG).forEach(s => {
      const visible = s === newScope || (newScope === 'federal' && s === 'states');
      try {
        map.setLayoutProperty(`${s}-fill`, 'visibility', visible ? 'visible' : 'none');
        map.setLayoutProperty(`${s}-line`, 'visibility', visible ? 'visible' : 'none');
      } catch {
        // Layer may not exist yet
      }
    });

    // Zoom to appropriate level for the scope
    const targetZoom = SCOPE_ZOOM[newScope];
    const currentZoom = map.getZoom();
    if (Math.abs(currentZoom - targetZoom) > 1) {
      map.easeTo({ zoom: targetZoom, duration: 600 });
    }

    setScope(newScope);
    setTooltip(null);
  }, []);

  return (
    <div className="relative w-full h-[70vh] min-h-[500px]">
      <div ref={containerRef} className="w-full h-full rounded-lg overflow-hidden border border-slate-200" />

      {/* Scope switcher */}
      <div className="absolute top-4 left-4 z-10">
        <ScopeSwitcher onScopeChange={handleScopeChange} initialScope="states" />
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-20 pointer-events-none bg-white border border-slate-200 rounded px-2.5 py-1.5 text-sm font-medium text-slate-800 shadow-md"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          {tooltip.name}
        </div>
      )}

      {/* Federal info card */}
      {scope === 'federal' && (
        <div className="absolute top-4 right-4 z-10 bg-white/95 backdrop-blur border border-slate-200 rounded-lg p-4 shadow-sm max-w-xs">
          <h3 className="font-semibold text-civic-navy text-sm mb-1">Federal Government</h3>
          <p className="text-xs text-slate-500 leading-relaxed">The map shows state boundaries for orientation. Explore federal branches, agencies, and officials.</p>
          <a href="/federal" className="text-xs text-civic-blue hover:underline mt-2 inline-block font-medium">Go to Federal Overview &rarr;</a>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 bg-white/95 backdrop-blur border border-slate-200 rounded-lg px-3 py-2 shadow-sm">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: LAYER_CONFIG[scope === 'federal' ? 'states' : scope].color, opacity: 0.6 }} />
          <span className="capitalize">{scope === 'federal' ? 'States' : scope}</span>
          <span className="text-slate-300">|</span>
          <span>Click to explore</span>
        </div>
      </div>
    </div>
  );
}
