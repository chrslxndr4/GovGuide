#!/bin/bash
set -e

DATA_DIR="public/data"
mkdir -p "$DATA_DIR"

echo "Downloading state boundaries..."
curl -o /tmp/states.zip "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_state_500k.zip"
unzip -o /tmp/states.zip -d /tmp/states/

echo "Downloading county boundaries..."
curl -o /tmp/counties.zip "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip"
unzip -o /tmp/counties.zip -d /tmp/counties/

echo "Downloading congressional district boundaries..."
curl -o /tmp/districts.zip "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_cd118_500k.zip"
unzip -o /tmp/districts.zip -d /tmp/districts/

echo "Converting to GeoJSON..."
ogr2ogr -f GeoJSON /tmp/states.geojson /tmp/states/cb_2020_us_state_500k.shp
ogr2ogr -f GeoJSON /tmp/counties.geojson /tmp/counties/cb_2020_us_county_500k.shp
ogr2ogr -f GeoJSON /tmp/districts.geojson /tmp/districts/cb_2020_us_cd118_500k.shp

echo "Generating PMTiles..."
tippecanoe -o "$DATA_DIR/us-boundaries.pmtiles" \
  --force \
  --no-feature-limit \
  --no-tile-size-limit \
  -z 12 \
  --coalesce-densest-as-needed \
  --named-layer=states:/tmp/states.geojson \
  --named-layer=counties:/tmp/counties.geojson \
  --named-layer=districts:/tmp/districts.geojson

echo "PMTiles generated at $DATA_DIR/us-boundaries.pmtiles"
