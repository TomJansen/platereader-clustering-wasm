# Platereader Signal Clustering

A browser-based tool for clustering plate-reader assay readouts by nanobody and toxin. All computation runs locally via WebAssembly (Rust); no data leaves the browser.

## Features

- Accepts `.xlsx`, `.xls`, and `.csv` files (drop multiple files at once)
- Subtracts per-column background estimated from configurable background wells (default: `H09–H12`)
- Masks heatmap cells below a configurable signal cutoff (default: 10× background)
- Clusters rows and columns by average-linkage hierarchical clustering with Euclidean distance
- Renders interactive dendrograms for nanobody rows, toxin columns, or both
- Parses plate-reader comments such as `74-1 EL3` into plate `74-1` and toxin `EL3`
- Splits the heatmap into one clustered plot per plate number
- Selects one representative row per flat cluster
- Exports representative rows as CSV, or the full heatmap as PNG or SVG

## Build

Requires [wasm-pack](https://rustwasm.github.io/wasm-pack/).

```sh
wasm-pack build --target web --out-dir web/pkg
```

Then serve the `web` directory:

```sh
python3 -m http.server 8080 --directory web
```

Open `http://localhost:8080`.

Or go to `https://tomjansen.github.io/platereader-clustering-wasm/`