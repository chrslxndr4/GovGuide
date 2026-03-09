import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import ScopeSwitcher, { type Scope } from '../ScopeSwitcher';
import 'maplibre-gl/dist/maplibre-gl.css';

const LAYER_CONFIG: Record<Scope, { sourceLayer: string; color: string; hoverColor: string }> = {
  federal: { sourceLayer: 'states', color: '#1B2A4A', hoverColor: '#2563EB' },
  states: { sourceLayer: 'states', color: '#2563EB', hoverColor: '#1d4ed8' },
  counties: { sourceLayer: 'counties', color: '#4A90E2', hoverColor: '#2563EB' },
  districts: { sourceLayer: 'districts', color: '#D97706', hoverColor: '#b45309' },
};

export default function GovMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoveredRef = useRef<{ id: number; layer: string } | null>(null);
  const [scope, setScope] = useState<Scope>('states');

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

    map.on('load', () => {
      map.addSource('boundaries', {
        type: 'vector',
        url: 'pmtiles:///data/us-boundaries.pmtiles',
      });

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
            'line-width': scopeId === 'states' || scopeId === 'federal' ? 2 : 1,
          },
        });
      });

      // Hover handler using ref to avoid stale closure issues
      const handleMouseMove = (layerScope: string) => (e: maplibregl.MapMouseEvent & { features?: maplibregl.GeoJSONFeature[] }) => {
        if (!e.features?.length) return;
        map.getCanvas().style.cursor = 'pointer';

        const config = LAYER_CONFIG[layerScope as Scope];
        const id = e.features[0].id as number;

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
        if (hoveredRef.current) {
          const config = LAYER_CONFIG[hoveredRef.current.layer as Scope];
          map.setFeatureState(
            { source: 'boundaries', sourceLayer: config.sourceLayer, id: hoveredRef.current.id },
            { hover: false }
          );
          hoveredRef.current = null;
        }
      };

      // Click handlers
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
          // Navigate using FIPS for now, will resolve to state slug later
          window.location.href = `/counties/${props.STATEFP}-${countySlug}`;
        }
      });

      // Register hover handlers for interactive layers
      ['states', 'counties', 'districts'].forEach(layerScope => {
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

    setScope(newScope);
  }, []);

  return (
    <div className="relative w-full h-[70vh] min-h-[500px]">
      <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden" />
      <div className="absolute top-4 left-4 z-10">
        <ScopeSwitcher onScopeChange={handleScopeChange} initialScope="states" />
      </div>
      {scope === 'federal' && (
        <div className="absolute top-4 right-4 z-10 bg-white/90 backdrop-blur rounded-lg p-4 shadow-lg max-w-xs">
          <h3 className="font-bold text-civic-navy text-sm mb-1">Federal Government</h3>
          <p className="text-xs text-civic-slate">The map shows state boundaries for orientation. Explore federal branches, agencies, and officials.</p>
          <a href="/federal" className="text-xs text-civic-blue hover:underline mt-2 inline-block">Go to Federal Overview &rarr;</a>
        </div>
      )}
    </div>
  );
}
