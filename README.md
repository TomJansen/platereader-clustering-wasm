# Platereader Signal Clustering

A browser-based tool for clustering plate-reader assay readouts by nanobody and toxin. All computation runs locally via WebAssembly (Rust); no data leaves the browser.

## Features

- Accepts `.xlsx`, `.xls`, and `.csv` files (drop multiple files at once) from Victor Nivo plate readers
- Subtracts per-column background estimated from configurable background wells (default: `H09–H12`)
- Masks heatmap cells below a configurable signal cutoff (default: 10× background)
- Clusters rows and/or columns by average-linkage hierarchical clustering with Euclidean distance
- Renders interactive dendrograms for nanobody rows, toxin columns, or both
- Parses plate-reader comments such as `TPL1274-1 EL3` into plate `TPL1274-1` and target `EL3`
- Splits the heatmap into one clustered plot per plate number
- Can export plots in png or svg formats

## Usage

Try it out at https://tomjansen.github.io/platereader-clustering-wasm/

### Build

Requires [wasm-pack](https://rustwasm.github.io/wasm-pack/).

```sh
wasm-pack build --target web --out-dir web/pkg
```

Then serve the `web` directory, for example with python:

```sh
python3 -m http.server 8080 --directory web
```

Open `http://localhost:8080`.


# License

GPL v3.0