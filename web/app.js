import init, { analyze_dataset, cluster_matrix } from "./pkg/platereader_signal_clustering.js";

const STANDARD_BACKGROUND_WELLS = "H09, H10, H11, H12";

const CSV_DEST_PLATE_PREFIX = "MA";
const CSV_DEST_PLATE_COLS = 12;
const CSV_DEST_PLATE_FULL_ROWS = 7; // Rows A-G (84 wells)
const CSV_DEST_PLATE_USABLE_WELLS = 94; // Total wells before skipping
const CSV_DEST_PLATE_SKIPPED_WELLS = ["H11", "H12"];

const PARSE_RESULT_SHEET_REGEX = /result/i;
const PARSE_PARAMETERS_SHEET_NAME = "parameters";
const PARSE_PARAMETERS_CELL = "B6";
const PARSE_COMMENT_REGEX = /(?:^|\n)\s*Comment:\s*([^\n\r]+)/i;
const PARSE_ASSAY_LABEL_REGEX = /^(\S+)\s+(.+)$/;

const PARSE_LINEAR_WELL_COL = 0; // Col A (0-indexed)
const PARSE_LINEAR_VALUE_COL = 1; // Col B (0-indexed)
const PARSE_LINEAR_START_ROW = 16; // Row 17 (0-indexed)
const PARSE_LINEAR_END_ROW = 111; // Row 112 (0-indexed)

const PARSE_PLATE_GRID_START_ROW = 17; // Row 18 (0-indexed)
const PARSE_PLATE_GRID_END_ROW = 24; // Row 25 (0-indexed)
const PARSE_PLATE_GRID_START_COL = 1; // Col B (0-indexed)
const PARSE_PLATE_GRID_END_COL = 12; // Col M (0-indexed)
const PARSE_PLATE_GRID_ROW_LETTERS = "ABCDEFGH";

const BAR_INK = "#0b0b0b";
const BAR_MUTED = "#52514e";
const BAR_FILL = "#2a78d6";
const BAR_PICKED = "#e65100";
const BAR_GRID = "#e6e6e3";
const BAR_AXIS = "#c9c9c4";
const BAR_BACKGROUND_LINE = "#d1342f";
const BAR_BACKGROUND_DASH = [5, 4];

const fileInput = document.querySelector("#fileInput");
const fileName = document.querySelector("#fileName");
const backgroundSuffix = document.querySelector("#backgroundSuffix");
const cutoffMultiplier = document.querySelector("#cutoffMultiplier");
const clusterDistance = document.querySelector("#clusterDistance");
const runButton = document.querySelector("#runButton");
const selectRepsButton = document.querySelector("#selectRepsButton");
const downloadPickedButton = document.querySelector("#downloadPickedButton");
const downloadPngButton = document.querySelector("#downloadPngButton");
const downloadSvgButton = document.querySelector("#downloadSvgButton");
const heatmap = document.querySelector("#heatmap");

const clusterBoth = document.querySelector("#clusterBoth");
const clusterNanobody = document.querySelector("#clusterNanobody");
const clusterToxin = document.querySelector("#clusterToxin");
const errorMessage = document.querySelector("#errorMessage");

const correctFastaButton = document.querySelector("#correctFastaButton");
const incorrectFastaButton = document.querySelector("#incorrectFastaButton");
const clearFastaButton = document.querySelector("#clearFastaButton");
const correctFastaInput = document.querySelector("#correctFastaInput");
const incorrectFastaInput = document.querySelector("#incorrectFastaInput");
const fastaSummary = document.querySelector("#fastaSummary");

let workbooks = [];
let lastResult = null;
// Raw, pre-background-subtraction sheet handed to analyze_dataset. Bar charts plot
// these signals; analyze_dataset both subtracts background and drops the background
// wells, so lastResult cannot reproduce the full plate.
let lastRawSheet = null;
let lastColumnFiles = [];
let clusterMode = "nanobody";
let selectedRows = new Set();
let plateClusters = new Map();
// Sequencing status keyed by `${plate}::${well}` (both lowercased).
let correctClones = new Set();
let incorrectClones = new Set();

await init();

const fileDrop = document.querySelector("#fileDrop");

fileDrop.addEventListener("click", () => fileInput.click());

fileDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileDrop.classList.add("drag-over");
});

fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("drag-over"));

fileDrop.addEventListener("drop", async (e) => {
  e.preventDefault();
  fileDrop.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer.files).filter(f => /\.(xlsx|xls|csv)$/i.test(f.name));
  if (!files.length) return;
  await loadFiles(files);
});

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  await loadFiles(files);
});

async function loadFiles(files) {
  fileName.textContent = files.length === 1 ? files[0].name : `${files.length} files selected`;
  workbooks = [];
  for (const file of files) {
    const data = await file.arrayBuffer();
    workbooks.push({
      fileName: file.name,
      workbook: XLSX.read(data, { type: "array" }),
    });
  }

  runButton.disabled = false;
  correctFastaButton.disabled = false;
  incorrectFastaButton.disabled = false;
}

runButton.addEventListener("click", () => {
  if (!workbooks.length) return;

  try {
    const parsedTables =
      workbooks.length === 1
        ? [firstResultSheet(workbooks[0].workbook)].map((sheetName) => readSheet(workbooks[0], sheetName))
        : workbooks.map((entry) => readSheet(entry, firstResultSheet(entry.workbook)));
    const mergedPlateReaderSheet = mergePlateReaderTables(parsedTables);
    const sheets = mergedPlateReaderSheet?.sheets || parsedTables.map((table) => table.sheet);
    lastColumnFiles =
      mergedPlateReaderSheet?.sourceFiles || columnSourceFiles(parsedTables, sheets[0]?.columns || []);
    const dataset = {
      sheets,
      options: {
        all_sheets: false,
        background_suffix: backgroundSuffix.value.trim() || STANDARD_BACKGROUND_WELLS,
        exclude_suffix: backgroundSuffix.value.trim() || STANDARD_BACKGROUND_WELLS,
        cutoff_multiplier: Number(cutoffMultiplier.value) || 10,
      },
    };

    lastRawSheet = sheets[0] || null;
    lastResult = analyze_dataset(dataset);
    renderResult(lastResult);
    selectRepsButton.disabled = false;
    downloadPngButton.disabled = false;
    downloadSvgButton.disabled = false;
    selectedRows.clear();
    updatePickedButton();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Analysis failed:", error);
    errorMessage.textContent = message;
    errorMessage.style.display = "block";
    return;
  }
  errorMessage.style.display = "none";
});

function getRepPickIds() {
  if (!lastResult) return [];
  const plateGroups = groupColumnsByPlate(lastResult.columns);
  const ids = [];
  plateGroups.forEach((group) => {
    const rowCluster = plateClusters.get(group.plate);
    if (rowCluster && rowCluster.clusters) {
      const clusterBest = new Map();
      rowCluster.order.forEach((rowIndex) => {
        const clusterId = rowCluster.clusters[rowIndex];
        const row = lastResult.rows[rowIndex];
        
        const score = group.columns.reduce((sum, col) => sum + row.masked_log_values[col.index], 0);
        
        if (score > 0) {
          const currentBest = clusterBest.get(clusterId);
          if (!currentBest || score > currentBest.score) {
            clusterBest.set(clusterId, { rowIndex, score });
          }
        }
      });

      clusterBest.forEach((best) => {
        ids.push(`${group.plate}::${best.rowIndex}`);
      });
    }
  });
  return ids;
}

function updateSelectRepsButton() {
  if (!lastResult) return;
  const repIds = getRepPickIds();
  const allSelected = repIds.length > 0 && repIds.every((id) => selectedRows.has(id));
  selectRepsButton.textContent = allSelected ? "Deselect representatives" : "Select representatives";
}

selectRepsButton.addEventListener("click", () => {
  if (!lastResult) return;
  const repIds = getRepPickIds();
  const allSelected = repIds.every((id) => selectedRows.has(id));
  if (allSelected) {
    repIds.forEach((id) => selectedRows.delete(id));
  } else {
    repIds.forEach((id) => selectedRows.add(id));
  }
  const repIdSet = new Set(repIds);
  document.querySelectorAll(".row-label").forEach((el) => {
    if (repIdSet.has(el.dataset.pickId)) {
      el.classList.toggle("selected", selectedRows.has(el.dataset.pickId));
    }
  });
  updatePickedButton();
  updateSelectRepsButton();
});

function updatePickedButton() {
  const count = selectedRows.size;
  downloadPickedButton.textContent = `Download Picked (${count})`;
  downloadPickedButton.disabled = count === 0;
  updateSelectRepsButton();
}

downloadPickedButton.addEventListener("click", () => {
  if (!lastResult || selectedRows.size === 0) return;
  const picked = [...selectedRows].map((pickId) => {
    const [sourcePlate, rowIndexStr] = pickId.split("::");
    const row = lastResult.rows[Number(rowIndexStr)];
    return row ? { sourcePlate, sourceWell: row.label } : null;
  }).filter(Boolean).sort((a, b) => {
    const plateCmp = naturalCompare(a.sourcePlate, b.sourcePlate);
    if (plateCmp !== 0) return plateCmp;
    return naturalCompare(a.sourceWell, b.sourceWell);
  });

  const wellLetters = "ABCDEFGH";
  const csvRows = [];
  let destPlateNum = 1;
  let wellPos = 0;
  let prevSourcePlate = null;
  for (const { sourcePlate, sourceWell } of picked) {
    if (wellPos === CSV_DEST_PLATE_USABLE_WELLS) {
      const plate = `${CSV_DEST_PLATE_PREFIX}${destPlateNum}`;
      CSV_DEST_PLATE_SKIPPED_WELLS.forEach((well) => {
        csvRows.push(["EMPTY", "EMPTY", "EMPTY", plate, well, ""].join(","));
      });
      csvRows.push("");
      destPlateNum++;
      wellPos = 0;
    }
    if (prevSourcePlate !== null && sourcePlate !== prevSourcePlate) {
      csvRows.push("");
    }
    prevSourcePlate = sourcePlate;
    const destPlate = `${CSV_DEST_PLATE_PREFIX}${destPlateNum}`;

    let row, col;
    const fullRowsWells = CSV_DEST_PLATE_FULL_ROWS * CSV_DEST_PLATE_COLS;
    if (wellPos < fullRowsWells) {
      row = Math.floor(wellPos / CSV_DEST_PLATE_COLS);
      col = wellPos % CSV_DEST_PLATE_COLS;
    } else {
      row = CSV_DEST_PLATE_FULL_ROWS;
      col = wellPos - fullRowsWells;
    }
    const destWell = `${wellLetters[row]}${String(col + 1).padStart(2, "0")}`;
    const clone = csvCell(`${sourcePlate}_${sourceWell}`);
    csvRows.push([clone, csvCell(sourcePlate), csvCell(sourceWell), csvCell(destPlate), csvCell(destWell), ""].join(","));
    wellPos++;
  }
  if (wellPos > 0) {
    const plate = `${CSV_DEST_PLATE_PREFIX}${destPlateNum}`;
    CSV_DEST_PLATE_SKIPPED_WELLS.forEach((well) => {
      csvRows.push(["EMPTY", "EMPTY", "EMPTY", plate, well, ""].join(","));
    });
  }
  const csv = ["Clone,MasterPlate,From well,To MasterActivePlate,To well,Done?"].concat(csvRows).join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv" }), "picked.csv");
});

downloadPngButton.addEventListener("click", () => downloadPlots("png"));
downloadSvgButton.addEventListener("click", () => downloadPlots("svg"));

// One archive per export: a heatmap per plate, plus a well-signal bar chart per
// source sheet.
async function downloadPlots(format) {
  if (!lastResult) return;
  const isPng = format === "png";
  const plateGroups = groupColumnsByPlate(lastResult.columns);
  const usedHeatmaps = new Set();
  const usedBars = new Set();
  const files = [];

  for (const group of plateGroups) {
    files.push({
      name: `heatmaps/${uniqueFileName(group.plate || "heatmap", usedHeatmaps)}.${format}`,
      blob: isPng
        ? await renderPlateGroupToPNG(lastResult, group)
        : renderPlateGroupToSVG(lastResult, group),
    });
    for (const column of group.columns) {
      files.push({
        name: `bar_charts/${uniqueFileName(column.label, usedBars)}.${format}`,
        blob: isPng
          ? await renderBarChartToPNG(lastResult, group, column)
          : renderBarChartToSVG(lastResult, group, column),
      });
    }
  }

  downloadBlob(await createZipBlob(files), "plots.zip");
}

function uniqueFileName(label, used) {
  const base = String(label).trim().replace(/[^\w.-]+/g, "_") || "plot";
  let name = base;
  for (let suffix = 2; used.has(name); suffix++) {
    name = `${base}_${suffix}`;
  }
  used.add(name);
  return name;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  const date = new Date();
  const dosTime = dosDateTime(date);

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    const localHeader = zipLocalFileHeader(nameBytes, data.length, crc, dosTime);
    const centralHeader = zipCentralDirectoryHeader(nameBytes, data.length, crc, dosTime, offset);

    chunks.push(localHeader, data);
    centralDirectory.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirectoryStart = offset;
  for (const header of centralDirectory) {
    chunks.push(header);
    offset += header.length;
  }
  chunks.push(zipEndOfCentralDirectory(files.length, offset - centralDirectoryStart, centralDirectoryStart));

  return new Blob(chunks, { type: "application/zip" });
}

function zipLocalFileHeader(nameBytes, size, crc, dosTime) {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime.time, true);
  view.setUint16(12, dosTime.date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function zipCentralDirectoryHeader(nameBytes, size, crc, dosTime, offset) {
  const header = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosTime.time, true);
  view.setUint16(14, dosTime.date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  header.set(nameBytes, 46);
  return header;
}

function zipEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectorySize, true);
  view.setUint32(16, centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
  return header;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

async function renderPlateGroupToPNG(result, group) {
  const exportData = plateExportData(result, group);
  const { layout, orderedColumns, orderedRows, rowCluster, columnCluster, localColumnOrder, localRowOrder } =
    exportData;
  const {
    scale,
    margin,
    headerHeight,
    dendrogramWidth,
    dendrogramHeight,
    rowLabelWidth,
    columnLabelHeight,
    cellWidth,
    cellHeight,
    matrixX,
    matrixY,
    heatmapX,
    heatmapY,
    width,
    height,
  } = layout;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  drawExportHeader(ctx, group, margin, margin, width - margin * 2);
  if (clusterMode === "toxin" || clusterMode === "both") {
    drawExportDendrogram(ctx, columnCluster.tree, localColumnOrder, "top", heatmapX, margin + headerHeight, cellWidth, dendrogramHeight);
  }
  if (clusterMode === "nanobody" || clusterMode === "both") {
    drawExportDendrogram(ctx, rowCluster.tree, localRowOrder, "left", margin, heatmapY, cellHeight, dendrogramWidth);
  }
  drawExportHeatmap(ctx, result, group, orderedColumns, orderedRows, localRowOrder, matrixX, matrixY, rowLabelWidth, columnLabelHeight, cellWidth, cellHeight);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas export failed."));
    }, "image/png");
  });
}

function renderPlateGroupToSVG(result, group) {
  const exportData = plateExportData(result, group);
  const { layout } = exportData;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<style>text{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>`,
    svgExportHeader(group, layout.margin, layout.margin),
    svgExportDendrograms(exportData),
    svgExportHeatmap(result, group, exportData),
    `</svg>`,
  ].join("");

  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

function plateExportData(result, group) {
  const rowMatrix = result.rows.map((row) =>
    group.columns.map((column) => row.masked_log_values[column.index]),
  );
  const rowCluster = cluster_matrix({ matrix: rowMatrix, distance: Number(clusterDistance.value) || 0.5 });
  const columnCluster = cluster_matrix({ matrix: transpose(rowMatrix) });
  const localColumnOrder =
    clusterMode === "toxin" || clusterMode === "both"
      ? columnCluster.order
      : group.columns.map((_, index) => index);
  const localRowOrder =
    clusterMode === "nanobody" || clusterMode === "both"
      ? rowCluster.order
      : result.rows.map((_, index) => index);
  const orderedColumns = localColumnOrder.map((index) => group.columns[index]);
  const orderedRows = localRowOrder.map((index) => result.rows[index]);

  const scale = 2;
  const margin = 16;
  const headerHeight = 44;
  const dendrogramWidth = clusterMode === "toxin" ? 0 : 150;
  const dendrogramHeight = clusterMode === "nanobody" ? 0 : 96;
  const rowLabelWidth = 60;
  const columnLabelHeight = 118;
  const cellWidth = 62;
  const cellHeight = 26;
  const matrixX = margin + dendrogramWidth;
  const matrixY = margin + headerHeight + dendrogramHeight;
  const heatmapX = matrixX + rowLabelWidth;
  const heatmapY = matrixY + columnLabelHeight;
  const width = margin * 2 + dendrogramWidth + rowLabelWidth + orderedColumns.length * cellWidth;
  const height =
    margin * 2 + headerHeight + dendrogramHeight + columnLabelHeight + orderedRows.length * cellHeight;

  return {
    rowCluster,
    columnCluster,
    localColumnOrder,
    localRowOrder,
    orderedColumns,
    orderedRows,
    layout: {
      scale,
      margin,
      headerHeight,
      dendrogramWidth,
      dendrogramHeight,
      rowLabelWidth,
      columnLabelHeight,
      cellWidth,
      cellHeight,
      matrixX,
      matrixY,
      heatmapX,
      heatmapY,
      width,
      height,
    },
  };
}

// Per-sheet well signals, ranked highest to lowest, with the wells picked in the
// UI called out. Mirrors plot_plate() in extract_well_signals.py: raw signals,
// every well on the plate. result.rows cannot be used -- analyze_dataset returns
// background-subtracted values and omits the background wells entirely.
function barChartData(result, group, column) {
  const pickedLabels = pickedLabelsFor(result, group);
  const source = lastRawSheet?.rows || [];
  const bars = source
    .map((row) => ({
      label: row.label,
      value: row.values[column.index],
      picked: pickedLabels.has(row.label),
    }))
    .filter((bar) => Number.isFinite(bar.value))
    .sort((a, b) => b.value - a.value);

  // The axis must clear the background line too, or it would render off the top of
  // a plate whose wells all sit below background.
  const backgroundMean = backgroundMeanFor(column);
  const axisMax = niceCeiling(Math.max(0, backgroundMean ?? 0, ...bars.map((bar) => bar.value)));
  const ticks = [];
  for (let tick = 0; tick <= AXIS_TICKS; tick++) {
    ticks.push((tick * axisMax) / AXIS_TICKS);
  }

  const scale = 2;
  const margin = 16;
  const titleHeight = 28;
  const plotLeft = 64;
  const slotWidth = 12;
  const plotWidth = Math.max(1, bars.length) * slotWidth;
  const plotHeight = 320;
  const labelHeight = 34;
  const plotX = margin + plotLeft;
  const plotY = margin + titleHeight;

  return {
    bars,
    ticks,
    axisMax,
    backgroundMean,
    title: (column.plate ? `${column.plate} ${column.target}` : column.target) || column.label,
    layout: {
      scale,
      margin,
      titleHeight,
      plotLeft,
      slotWidth,
      plotWidth,
      plotHeight,
      labelHeight,
      plotX,
      plotY,
      width: margin * 2 + plotLeft + plotWidth,
      height: margin * 2 + titleHeight + plotHeight + labelHeight,
    },
  };
}

// Mean raw signal of this column's background wells, matching background_signal()
// in src/lib.rs: wells are selected by label suffix, and the mean is rounded.
// Returns null when no well matches, so the chart simply omits the line.
function backgroundMeanFor(column) {
  const suffixes = (backgroundSuffix.value.trim() || STANDARD_BACKGROUND_WELLS)
    .split(/[,;\s]+/)
    .filter(Boolean);
  if (!suffixes.length) return null;

  const controls = (lastRawSheet?.rows || []).filter((row) =>
    suffixes.some((suffix) => row.label.endsWith(suffix)),
  );
  const values = controls.map((row) => row.values[column.index]).filter(Number.isFinite);
  if (!values.length) return null;

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// selectedRows keys on the row index into result.rows, but bar charts iterate the
// raw sheet, which has a different length and order. Bridge the two by well label.
function pickedLabelsFor(result, group) {
  const labels = new Set();
  selectedRows.forEach((pickId) => {
    const separator = pickId.lastIndexOf("::");
    if (separator < 0 || pickId.slice(0, separator) !== group.plate) return;
    const row = result.rows[Number(pickId.slice(separator + 2))];
    if (row) labels.add(row.label);
  });
  return labels;
}

const AXIS_TICKS = 5;
const NICE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

// Axis ceiling for `value`: pick a round *tick step* and multiply up, so every
// gridline label is a whole number and the tallest bar still fills most of the
// plot (10164 -> 12500 rather than the 20000 a plain 1/2/5 ceiling would give).
// Signals are counts, so an integral step is always available.
function niceCeiling(value) {
  if (!(value > 0)) return AXIS_TICKS;
  const rough = value / AXIS_TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = NICE_STEPS.reduce((best, candidate) => {
    const scaled = candidate * magnitude;
    const usable = normalized <= candidate + 1e-9 && Number.isInteger(scaled);
    return best === null && usable ? scaled : best;
  }, null);
  return Math.max(1, step ?? Math.ceil(rough)) * AXIS_TICKS;
}

function barY(value, chart) {
  const { plotY, plotHeight } = chart.layout;
  return plotY + plotHeight - (value / chart.axisMax) * plotHeight;
}

function formatTick(value) {
  return Math.abs(value) >= 1000 ? Math.round(value).toLocaleString("en-US") : String(Math.round(value));
}

async function renderBarChartToPNG(result, group, column) {
  const chart = barChartData(result, group, column);
  const { scale, margin, plotX, plotY, plotWidth, plotHeight, slotWidth, width, height } = chart.layout;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = BAR_INK;
  ctx.font = "700 14px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(chart.title, margin, margin + 4);

  ctx.strokeStyle = BAR_GRID;
  ctx.lineWidth = 1;
  ctx.font = "8px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  chart.ticks.forEach((tick) => {
    const y = barY(tick, chart);
    ctx.strokeStyle = BAR_GRID;
    drawLine(ctx, plotX, y, plotX + plotWidth, y);
    ctx.fillStyle = BAR_MUTED;
    ctx.textAlign = "right";
    ctx.fillText(formatTick(tick), plotX - 8, y);
  });

  const barWidth = slotWidth * 0.7;
  chart.bars.forEach((bar, index) => {
    const slotX = plotX + index * slotWidth;
    const top = barY(bar.value, chart);
    ctx.fillStyle = bar.picked ? BAR_PICKED : BAR_FILL;
    ctx.fillRect(slotX + (slotWidth - barWidth) / 2, top, barWidth, plotY + plotHeight - top);

    ctx.save();
    ctx.translate(slotX + slotWidth / 2, plotY + plotHeight + 6);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = bar.picked ? BAR_PICKED : BAR_MUTED;
    ctx.font = `${bar.picked ? "700" : "400"} 7px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
    ctx.fillText(bar.label, 0, 0);
    ctx.restore();
  });

  ctx.strokeStyle = BAR_AXIS;
  drawLine(ctx, plotX, plotY + plotHeight, plotX + plotWidth, plotY + plotHeight);

  if (chart.backgroundMean !== null) {
    const lineY = barY(chart.backgroundMean, chart);
    ctx.save();
    ctx.setLineDash(BAR_BACKGROUND_DASH);
    ctx.strokeStyle = BAR_BACKGROUND_LINE;
    ctx.lineWidth = 1.2;
    drawLine(ctx, plotX, lineY, plotX + plotWidth, lineY);
    ctx.restore();

    // Right-aligned: bars are sorted descending, so the right edge is always clear.
    ctx.fillStyle = BAR_BACKGROUND_LINE;
    ctx.font = "700 8px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`background ${formatTick(chart.backgroundMean)}`, plotX + plotWidth, lineY - 3);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas export failed."));
    }, "image/png");
  });
}

function renderBarChartToSVG(result, group, column) {
  const chart = barChartData(result, group, column);
  const { margin, plotX, plotY, plotWidth, plotHeight, slotWidth, width, height } = chart.layout;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<style>text{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>`,
    `<text x="${margin}" y="${margin + 14}" fill="${BAR_INK}" font-size="14" font-weight="700">${escapeText(chart.title)}</text>`,
  ];

  chart.ticks.forEach((tick) => {
    const y = barY(tick, chart);
    parts.push(
      `<line x1="${plotX}" y1="${y.toFixed(2)}" x2="${plotX + plotWidth}" y2="${y.toFixed(2)}" stroke="${BAR_GRID}" stroke-width="1"/>`,
      `<text x="${plotX - 8}" y="${(y + 3).toFixed(2)}" fill="${BAR_MUTED}" font-size="8" text-anchor="end">${formatTick(tick)}</text>`,
    );
  });

  const barWidth = slotWidth * 0.7;
  chart.bars.forEach((bar, index) => {
    const slotX = plotX + index * slotWidth;
    const top = barY(bar.value, chart);
    const labelX = slotX + slotWidth / 2;
    const labelY = plotY + plotHeight + 6;
    parts.push(
      `<rect x="${(slotX + (slotWidth - barWidth) / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(plotY + plotHeight - top).toFixed(2)}" fill="${bar.picked ? BAR_PICKED : BAR_FILL}"/>`,
      `<text transform="translate(${labelX.toFixed(2)} ${labelY}) rotate(-90)" fill="${bar.picked ? BAR_PICKED : BAR_MUTED}" font-size="7" font-weight="${bar.picked ? "700" : "400"}" text-anchor="end" dy="2.5">${escapeText(bar.label)}</text>`,
    );
  });

  parts.push(
    `<line x1="${plotX}" y1="${plotY + plotHeight}" x2="${plotX + plotWidth}" y2="${plotY + plotHeight}" stroke="${BAR_AXIS}" stroke-width="1"/>`,
  );

  if (chart.backgroundMean !== null) {
    const lineY = barY(chart.backgroundMean, chart).toFixed(2);
    parts.push(
      `<line x1="${plotX}" y1="${lineY}" x2="${plotX + plotWidth}" y2="${lineY}" stroke="${BAR_BACKGROUND_LINE}" stroke-width="1.2" stroke-dasharray="${BAR_BACKGROUND_DASH.join(" ")}"/>`,
      `<text x="${plotX + plotWidth}" y="${(Number(lineY) - 3).toFixed(2)}" fill="${BAR_BACKGROUND_LINE}" font-size="8" font-weight="700" text-anchor="end">background ${formatTick(chart.backgroundMean)}</text>`,
    );
  }

  parts.push(`</svg>`);

  return new Blob([parts.join("")], { type: "image/svg+xml;charset=utf-8" });
}

function svgExportHeader(group, x, y) {
  const title = escapeText(group.plate);
  const titleWidth = Math.max(0, String(group.plate).length * 10);
  return [
    `<rect x="${x}" y="${y}" width="${titleWidth + 100}" height="32" fill="#ffffff"/>`,
    `<text x="${x}" y="${y + 20}" fill="#24302d" font-size="18" font-weight="700">${title}</text>`,
    `<text x="${x + titleWidth + 12}" y="${y + 20}" fill="#71807b" font-size="12" font-weight="700">${group.columns.length} targets</text>`,
  ].join("");
}

function svgExportDendrograms(exportData) {
  const { layout, columnCluster, rowCluster, localColumnOrder, localRowOrder } = exportData;
  const parts = [];
  if (clusterMode === "toxin" || clusterMode === "both") {
    parts.push(
      svgExportDendrogram(
        columnCluster.tree,
        localColumnOrder,
        "top",
        layout.heatmapX,
        layout.margin + layout.headerHeight,
        layout.cellWidth,
        layout.dendrogramHeight,
      ),
    );
  }
  if (clusterMode === "nanobody" || clusterMode === "both") {
    parts.push(
      svgExportDendrogram(
        rowCluster.tree,
        localRowOrder,
        "left",
        layout.margin,
        layout.heatmapY,
        layout.cellHeight,
        layout.dendrogramWidth,
      ),
    );
  }
  return parts.join("");
}

function svgExportHeatmap(result, group, exportData) {
  const { orderedColumns, orderedRows, localRowOrder, layout } = exportData;
  const {
    matrixX,
    matrixY,
    rowLabelWidth,
    columnLabelHeight,
    cellWidth,
    cellHeight,
  } = layout;
  const min = result.stats.min_nonzero_log;
  const max = result.stats.max_log;
  const parts = [
    `<rect x="${matrixX}" y="${matrixY}" width="${rowLabelWidth}" height="${columnLabelHeight}" fill="#f9fbfa" stroke="#edf0ee"/>`,
  ];

  orderedColumns.forEach((column, columnIndex) => {
    const cellX = matrixX + rowLabelWidth + columnIndex * cellWidth;
    const label = escapeText(clipTextByLength(column.target || column.label, 18));
    const plate = escapeText(clipTextByLength(column.plate || "", 18));
    parts.push(
      `<rect x="${cellX}" y="${matrixY}" width="${cellWidth}" height="${columnLabelHeight}" fill="#f9fbfa" stroke="#edf0ee"/>`,
      `<text transform="translate(${cellX + cellWidth / 2} ${matrixY + columnLabelHeight - 10}) rotate(-90)" fill="#40504b" font-size="10" font-weight="700">${label}</text>`,
    );
    if (plate) {
      parts.push(
        `<text transform="translate(${cellX + cellWidth / 2} ${matrixY + columnLabelHeight - 10}) rotate(-90)" x="0" y="11" fill="#71807b" font-size="9" font-weight="600">${plate}</text>`,
      );
    }
  });

  orderedRows.forEach((row, rowPosition) => {
    const rowY = matrixY + columnLabelHeight + rowPosition * cellHeight;
    const rowIndex = localRowOrder[rowPosition];
    const pickId = `${group.plate}::${rowIndex}`;
    const isSelected = selectedRows.has(pickId);
    const seqStatus = sequencingStatusFor(group.plate, row.label);
    const rowFill = seqStatus === "incorrect" ? "#ffc266" : seqStatus === "correct" ? "#ffe98a" : isSelected ? "#fff3e6" : "#ffffff";
    parts.push(
      `<rect x="${matrixX}" y="${rowY}" width="${rowLabelWidth}" height="${cellHeight}" fill="${rowFill}" stroke="#edf0ee"/>`,
      `<text x="${matrixX + 10}" y="${rowY + cellHeight / 2 + 4}" fill="${isSelected ? "#e65100" : "#24302d"}" font-size="11" font-weight="${isSelected ? "700" : "400"}">${escapeText(row.label)}</text>`,
    );

    orderedColumns.forEach((column, columnPosition) => {
      const cellX = matrixX + rowLabelWidth + columnPosition * cellWidth;
      const raw = row.values[column.index];
      const masked = row.masked_log_values[column.index];
      const valueText = formatAssayValue(raw);
      parts.push(
        `<rect x="${cellX}" y="${rowY}" width="${cellWidth}" height="${cellHeight}" fill="${colorFor(masked, min, max)}" stroke="#edf0ee"/>`,
        `<text x="${cellX + cellWidth / 2}" y="${rowY + cellHeight / 2 + 4}" fill="#ffffff" font-size="10" text-anchor="middle">${valueText}</text>`,
      );
    });
  });

  return parts.join("");
}

function svgExportDendrogram(tree, order, orientation, x, y, step, depth) {
  if (!tree || depth <= 0) return "";
  const isTop = orientation === "top";
  const positions = new Map(order.map((index, position) => [index, position * step + step / 2]));
  const maxDistance = Math.max(0.0001, treeMaxDistance(tree));
  const lines = [];

  function walk(node) {
    if (node.kind === "Leaf") {
      const position = positions.get(node.index) ?? 0;
      return isTop ? { x: x + position, y: y + depth } : { x: x + depth, y: y + position };
    }

    const left = walk(node.left);
    const right = walk(node.right);
    const scaled = depth - (node.distance / maxDistance) * (depth - 8);
    const joint = isTop
      ? { x: (left.x + right.x) / 2, y: y + scaled }
      : { x: x + scaled, y: (left.y + right.y) / 2 };

    if (isTop) {
      lines.push(svgLine(left.x, left.y, left.x, joint.y));
      lines.push(svgLine(right.x, right.y, right.x, joint.y));
      lines.push(svgLine(left.x, joint.y, right.x, joint.y));
    } else {
      lines.push(svgLine(left.x, left.y, joint.x, left.y));
      lines.push(svgLine(right.x, right.y, joint.x, right.y));
      lines.push(svgLine(joint.x, left.y, joint.x, right.y));
    }

    return joint;
  }

  walk(tree);
  return lines.join("");
}

function svgLine(x1, y1, x2, y2) {
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#727a77" stroke-width="1.2"/>`;
}

function drawExportHeader(ctx, group, x, y, width) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, width, 32);
  ctx.fillStyle = "#24302d";
  ctx.font = "700 18px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(group.plate, x, y + 2);
  ctx.fillStyle = "#71807b";
  ctx.font = "700 12px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(`${group.columns.length} targets`, x + ctx.measureText(group.plate).width + 12, y + 8);
}

function drawExportHeatmap(ctx, result, group, columns, rows, rowOrder, x, y, rowLabelWidth, columnLabelHeight, cellWidth, cellHeight) {
  ctx.strokeStyle = "#edf0ee";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#f9fbfa";
  ctx.fillRect(x, y, rowLabelWidth, columnLabelHeight);
  columns.forEach((column, columnIndex) => {
    const cellX = x + rowLabelWidth + columnIndex * cellWidth;
    ctx.fillStyle = "#f9fbfa";
    ctx.fillRect(cellX, y, cellWidth, columnLabelHeight);
    ctx.save();
    ctx.translate(cellX + cellWidth / 2, y + columnLabelHeight - 10);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "left";
    ctx.fillStyle = "#40504b";
    ctx.font = "700 10px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    drawRotatedText(ctx, column.target || column.label, 0, 0, columnLabelHeight - 16);
    if (column.plate) {
      ctx.fillStyle = "#71807b";
      ctx.font = "600 9px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      drawRotatedText(ctx, column.plate, 0, 11, columnLabelHeight - 16);
    }
    ctx.restore();
    strokeRect(ctx, cellX, y, cellWidth, columnLabelHeight);
  });

  const min = result.stats.min_nonzero_log;
  const max = result.stats.max_log;
  rows.forEach((row, rowPosition) => {
    const rowY = y + columnLabelHeight + rowPosition * cellHeight;
    const rowIndex = rowOrder[rowPosition];
    const pickId = `${group.plate}::${rowIndex}`;
    const seqStatus = sequencingStatusFor(group.plate, row.label);
    ctx.fillStyle = seqStatus === "incorrect" ? "#ffc266" : seqStatus === "correct" ? "#ffe98a" : selectedRows.has(pickId) ? "#fff3e6" : "#ffffff";
    ctx.fillRect(x, rowY, rowLabelWidth, cellHeight);
    ctx.fillStyle = selectedRows.has(pickId) ? "#e65100" : "#24302d";
    ctx.font = `${selectedRows.has(pickId) ? "700" : "400"} 11px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(row.label, x + 10, rowY + cellHeight / 2);
    strokeRect(ctx, x, rowY, rowLabelWidth, cellHeight);

    columns.forEach((column, columnPosition) => {
      const cellX = x + rowLabelWidth + columnPosition * cellWidth;
      const raw = row.values[column.index];
      const masked = row.masked_log_values[column.index];
      const valueText = formatAssayValue(raw);
      ctx.fillStyle = colorFor(masked, min, max);
      ctx.fillRect(cellX, rowY, cellWidth, cellHeight);
      ctx.fillStyle = "#ffffff";
      ctx.font = "10px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(valueText, cellX + cellWidth / 2, rowY + cellHeight / 2, cellWidth - 4);
      strokeRect(ctx, cellX, rowY, cellWidth, cellHeight);
    });
  });
}

function drawExportDendrogram(ctx, tree, order, orientation, x, y, step, depth) {
  if (!tree || depth <= 0) return;
  const isTop = orientation === "top";
  const positions = new Map(order.map((index, position) => [index, position * step + step / 2]));
  const maxDistance = Math.max(0.0001, treeMaxDistance(tree));
  ctx.strokeStyle = "#727a77";
  ctx.lineWidth = 1.2;

  function walk(node) {
    if (node.kind === "Leaf") {
      const position = positions.get(node.index) ?? 0;
      return isTop ? { x: x + position, y: y + depth } : { x: x + depth, y: y + position };
    }
    const left = walk(node.left);
    const right = walk(node.right);
    const scaled = depth - (node.distance / maxDistance) * (depth - 8);
    const joint = isTop
      ? { x: (left.x + right.x) / 2, y: y + scaled }
      : { x: x + scaled, y: (left.y + right.y) / 2 };

    if (isTop) {
      drawLine(ctx, left.x, left.y, left.x, joint.y);
      drawLine(ctx, right.x, right.y, right.x, joint.y);
      drawLine(ctx, left.x, joint.y, right.x, joint.y);
    } else {
      drawLine(ctx, left.x, left.y, joint.x, left.y);
      drawLine(ctx, right.x, right.y, joint.x, right.y);
      drawLine(ctx, joint.x, left.y, joint.x, right.y);
    }
    return joint;
  }

  walk(tree);
}

function drawRotatedText(ctx, text, x, y, maxWidth) {
  const clipped = clipText(ctx, String(text), maxWidth);
  ctx.fillText(clipped, x, y);
}

function clipText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}...`;
}

function clipTextByLength(text, maxLength) {
  const value = String(text);
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 3))}...`;
}

function formatAssayValue(value) {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(Math.max(0, value)));
}

function strokeRect(ctx, x, y, width, height) {
  ctx.strokeRect(x + 0.5, y + 0.5, width, height);
}

function drawLine(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}


clusterBoth.addEventListener("click", () => setClusterMode("both"));
clusterNanobody.addEventListener("click", () => setClusterMode("nanobody"));
clusterToxin.addEventListener("click", () => setClusterMode("toxin"));

correctFastaButton.addEventListener("click", () => correctFastaInput.click());
incorrectFastaButton.addEventListener("click", () => incorrectFastaInput.click());
clearFastaButton.addEventListener("click", () => {
  correctClones.clear();
  incorrectClones.clear();
  correctFastaInput.value = "";
  incorrectFastaInput.value = "";
  applySequencingStatus();
});

correctFastaInput.addEventListener("change", () => loadFastaFiles(correctFastaInput.files, correctClones));
incorrectFastaInput.addEventListener("change", () => loadFastaFiles(incorrectFastaInput.files, incorrectClones));

async function loadFastaFiles(fileList, target) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    const text = await file.text();
    parseFastaIds(text).forEach((id) => target.add(id));
  }
  applySequencingStatus();
}

// Extract well keys (`${plate}::${well}`) from FASTA headers. Each header's clone
// id is the first whitespace-delimited token, e.g. ">73-1_A01 description" -> 73-1 / A01.
function parseFastaIds(text) {
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(">")) continue;
    const cloneId = line.slice(1).trim().split(/\s+/)[0];
    const key = cloneKey(cloneId);
    if (key) keys.push(key);
  }
  return keys;
}

// Split a clone id on its last underscore into plate + well, e.g. "73-1_A01".
function cloneKey(cloneId) {
  const underscore = cloneId.lastIndexOf("_");
  if (underscore <= 0 || underscore === cloneId.length - 1) return "";
  const plate = cloneId.slice(0, underscore);
  const well = normalizeWellLabel(cloneId.slice(underscore + 1));
  return wellKey(plate, well);
}

function wellKey(plate, well) {
  return `${String(plate).trim().toLowerCase()}::${String(well).trim().toLowerCase()}`;
}

// Incorrect (orange) takes priority over correct (yellow) when a well is in both.
function sequencingStatusFor(plate, well) {
  const key = wellKey(plate, well);
  if (incorrectClones.has(key)) return "incorrect";
  if (correctClones.has(key)) return "correct";
  return "";
}

function updateFastaSummary() {
  const hasAny = correctClones.size > 0 || incorrectClones.size > 0;
  clearFastaButton.disabled = !hasAny;
  fastaSummary.textContent = hasAny
    ? `${correctClones.size} correct, ${incorrectClones.size} incorrect`
    : "";
}

// Re-render so highlighting reflects the current sequencing sets.
function applySequencingStatus() {
  updateFastaSummary();
  if (lastResult) renderResult(lastResult);
}

function readSheet(entry, name) {
  const rows = XLSX.utils.sheet_to_json(entry.workbook.Sheets[name], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const lowerName = name.toLowerCase();
  const label = parametersComment(entry.workbook) || labelWithoutExtension(entry.fileName);
  const resultRows = [];

  if (lowerName.includes("well")) {
    for (let r = PARSE_LINEAR_START_ROW; r <= PARSE_LINEAR_END_ROW; r++) {
      const row = rows[r] || [];
      const wellLabel = normalizeWellLabel(String(row[PARSE_LINEAR_WELL_COL] ?? "").trim());
      const value = Number(row[PARSE_LINEAR_VALUE_COL] ?? 0);
      if (wellLabel && Number.isFinite(value)) {
        resultRows.push({ label: wellLabel, values: [value] });
      }
    }
  } else if (lowerName.includes("plate")) {
    for (let r = PARSE_PLATE_GRID_START_ROW; r <= PARSE_PLATE_GRID_END_ROW; r++) {
      const row = rows[r] || [];
      const explicitLetter = String(row[0] ?? "").trim().toUpperCase();
      const rowLetter = /^[A-Za-z]$/.test(explicitLetter)
        ? explicitLetter
        : PARSE_PLATE_GRID_ROW_LETTERS[r - PARSE_PLATE_GRID_START_ROW];

      for (let c = PARSE_PLATE_GRID_START_COL; c <= PARSE_PLATE_GRID_END_COL; c++) {
        const raw = row[c];
        if (raw === null || raw === undefined || String(raw).trim() === "") continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;

        const colNum = c - PARSE_PLATE_GRID_START_COL + 1;
        const wellLabel = `${rowLetter}${String(colNum).padStart(2, "0")}`;
        resultRows.push({ label: wellLabel, values: [value] });
      }
    }
  }

  if (resultRows.length > 0) {
    return {
      kind: "plate",
      sourceFiles: [entry.fileName],
      sheet: {
        name: label,
        columns: [label],
        rows: resultRows,
      },
    };
  }

  throw new Error(
    `Sheet '${name}' is not recognized. Ensure the sheet name contains 'well' or 'plate' and is from a Victor Nivo directly.`
  );
}

function firstResultSheet(workbook) {
  return workbook.SheetNames.find((name) => PARSE_RESULT_SHEET_REGEX.test(name)) || workbook.SheetNames[0];
}

function mergePlateReaderTables(tables) {
  if (!tables.length || tables.some((table) => table.kind !== "plate")) return null;

  const labels = tables[0].sheet.rows.map((row) => row.label);
  if (
    tables.some(
      (table) =>
        table.sheet.rows.length !== labels.length ||
        table.sheet.rows.some((row, index) => row.label !== labels[index]),
    )
  ) {
    throw new Error("Plate-reader files do not have matching well rows.");
  }

  return {
    sourceFiles: tables.map((table) => table.sourceFiles[0]),
    sheets: [
      {
        name: "Combined plate-reader exports",
        columns: tables.map((table) => table.sheet.columns[0]),
        rows: labels.map((label, rowIndex) => ({
          label,
          values: tables.map((table) => table.sheet.rows[rowIndex].values[0]),
        })),
      },
    ],
  };
}

function columnSourceFiles(parsedTables, columns) {
  const firstTable = parsedTables[0];
  if (!firstTable) return [];
  if (firstTable.sourceFiles.length === columns.length) return firstTable.sourceFiles;
  return columns.map(() => firstTable.sourceFiles[0] || "");
}

function labelWithoutExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function normalizeWellLabel(label) {
  return label.replace(/\b([A-Za-z])0?([1-9]|1[0-9]|2[0-4])\b/g, (_, row, column) => {
    return `${row.toUpperCase()}${column.padStart(2, "0")}`;
  });
}

function parametersComment(workbook) {
  const parametersSheetName = workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === PARSE_PARAMETERS_SHEET_NAME,
  );
  if (!parametersSheetName) return "";

  const cell = workbook.Sheets[parametersSheetName]?.[PARSE_PARAMETERS_CELL];
  const text = String(cell?.w ?? cell?.v ?? "");
  const match = text.match(PARSE_COMMENT_REGEX);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  return "";
}

function renderResult(result) {
  if (!result) return;
  const plateGroups = groupColumnsByPlate(result.columns);

  heatmap.className = "plot-stack";
  heatmap.style.removeProperty("--column-count");
  heatmap.style.removeProperty("--row-count");
  heatmap.replaceChildren();

  plateClusters.clear();

  plateGroups.forEach((group) => {
    heatmap.append(renderPlatePlot(result, group));
  });

}

function renderPlatePlot(result, group) {
  const rowMatrix = result.rows.map((row) =>
    group.columns.map((column) => row.masked_log_values[column.index]),
  );
  const rowCluster = cluster_matrix({ matrix: rowMatrix, distance: Number(clusterDistance.value) || 0.5 });
  plateClusters.set(group.plate, rowCluster);
  const columnCluster = cluster_matrix({ matrix: transpose(rowMatrix) });
  const localColumnOrder =
    clusterMode === "toxin" || clusterMode === "both"
      ? columnCluster.order
      : group.columns.map((_, index) => index);
  const localRowOrder =
    clusterMode === "nanobody" || clusterMode === "both"
      ? rowCluster.order
      : result.rows.map((_, index) => index);
  const orderedColumns = localColumnOrder.map((index) => group.columns[index]);
  const orderedRows = localRowOrder.map((index) => result.rows[index]);

  const section = document.createElement("section");
  section.className = "plate-plot";

  const header = document.createElement("header");
  header.className = "plate-header";
  header.innerHTML = `<h2>${escapeText(group.plate)}</h2><span>${group.columns.length} targets</span>`;
  section.append(header);

  const view = document.createElement("div");
  view.className = `cluster-view ${clusterMode}-mode`;
  view.style.setProperty("--column-count", orderedColumns.length);
  view.style.setProperty("--row-count", orderedRows.length);

  const topSpacer = document.createElement("div");
  topSpacer.className = "dendrogram-spacer";
  view.append(topSpacer);

  const topDendrogram = document.createElement("div");
  topDendrogram.className = "top-dendrogram";
  if (clusterMode === "toxin" || clusterMode === "both") {
    topDendrogram.append(drawDendrogram(columnCluster.tree, localColumnOrder, "top"));
  }
  view.append(topDendrogram);

  const leftDendrogram = document.createElement("div");
  leftDendrogram.className = "left-dendrogram";
  if (clusterMode === "nanobody" || clusterMode === "both") {
    leftDendrogram.append(drawDendrogram(rowCluster.tree, localRowOrder, "left"));
  }
  view.append(leftDendrogram);

  const matrix = document.createElement("div");
  matrix.className = "heatmap";
  matrix.style.setProperty("--column-count", orderedColumns.length);

  const corner = document.createElement("div");
  corner.className = "corner-cell";
  matrix.append(corner);

  orderedColumns.forEach((column) => {
    const cell = document.createElement("div");
    cell.className = "column-label";
    cell.title = [
      `Plate ${column.plate || "unknown"} / ${column.target || column.label}`,
      column.fileName ? `File: ${column.fileName}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    cell.innerHTML = `<strong>${escapeText(column.target || column.label)}</strong><span>${escapeText(
      column.plate || "",
    )}</span>`;
    matrix.append(cell);
  });

  const min = result.stats.min_nonzero_log;
  const max = result.stats.max_log;
  orderedRows.forEach((row, rowPosition) => {
    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = row.label;

    const rowIndex = localRowOrder[rowPosition];
    const pickId = `${group.plate}::${rowIndex}`;
    const plateCluster = rowCluster.clusters ? rowCluster.clusters[rowIndex] : 0;

    if (selectedRows.has(pickId)) {
      label.classList.add("selected");
    }
    const seqStatus = sequencingStatusFor(group.plate, row.label);
    if (seqStatus === "correct") {
      label.classList.add("seq-correct");
    } else if (seqStatus === "incorrect") {
      label.classList.add("seq-incorrect");
    }
    label.dataset.pickId = pickId;

    label.addEventListener("click", () => {
      if (selectedRows.has(pickId)) {
        selectedRows.delete(pickId);
      } else {
        selectedRows.add(pickId);
      }
      label.classList.toggle("selected", selectedRows.has(pickId));
      updatePickedButton();
    });

    matrix.append(label);

    orderedColumns.forEach((column) => {
      const raw = row.values[column.index];
      const masked = row.masked_log_values[column.index];
      const cell = document.createElement("div");
      cell.className = "value-cell";
      cell.style.background = colorFor(masked, min, max);
      cell.title = `${row.label} / ${column.label}: ${formatAssayValue(raw)} (cluster ${plateCluster})`;
      cell.textContent = formatAssayValue(raw);
      matrix.append(cell);
    });
  });

  view.append(matrix);
  section.append(view);
  return section;
}

function groupColumnsByPlate(columns) {
  const groups = new Map();
  columns.forEach((label, index) => {
    const parsed = parseAssayLabel(label);
    const plate = parsed.plate || "All assays";
    if (!groups.has(plate)) {
      groups.set(plate, { plate, columns: [] });
    }
    groups.get(plate).columns.push({
      index,
      label,
      fileName: lastColumnFiles[index] || "",
      ...parsed,
    });
  });

  return Array.from(groups.values()).sort((a, b) => naturalCompare(a.plate, b.plate));
}

function setClusterMode(mode) {
  clusterMode = mode;
  updateClusterButtons();
  if (lastResult) renderResult(lastResult);
}

function updateClusterButtons() {
  clusterBoth.classList.toggle("active", clusterMode === "both");
  clusterNanobody.classList.toggle("active", clusterMode === "nanobody");
  clusterToxin.classList.toggle("active", clusterMode === "toxin");
}

function parseAssayLabel(label) {
  const match = String(label).trim().match(PARSE_ASSAY_LABEL_REGEX);
  if (!match) {
    return { plate: "", target: String(label).trim() };
  }
  return {
    plate: match[1],
    target: match[2].trim(),
  };
}

function transpose(matrix) {
  if (!matrix.length) return [];
  return matrix[0].map((_, columnIndex) => matrix.map((row) => row[columnIndex]));
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function drawDendrogram(tree, order, orientation) {
  const isTop = orientation === "top";
  const step = isTop ? 62 : 30;
  const depth = isTop ? 96 : 150;
  const breadth = Math.max(1, order.length) * step;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `dendrogram-svg ${orientation}`);
  svg.setAttribute("width", isTop ? breadth : depth);
  svg.setAttribute("height", isTop ? depth : breadth);
  svg.setAttribute("viewBox", `0 0 ${isTop ? breadth : depth} ${isTop ? depth : breadth}`);
  svg.setAttribute("preserveAspectRatio", "none");

  const positions = new Map(order.map((index, position) => [index, position * step + step / 2]));
  const maxDistance = Math.max(0.0001, treeMaxDistance(tree));

  function walk(node) {
    if (node.kind === "Leaf") {
      const position = positions.get(node.index) ?? 0;
      return isTop ? { x: position, y: depth } : { x: depth, y: position };
    }

    const left = walk(node.left);
    const right = walk(node.right);
    const scaled = depth - (node.distance / maxDistance) * (depth - 8);
    const joint = isTop
      ? { x: (left.x + right.x) / 2, y: scaled }
      : { x: scaled, y: (left.y + right.y) / 2 };

    if (isTop) {
      line(svg, left.x, left.y, left.x, joint.y);
      line(svg, right.x, right.y, right.x, joint.y);
      line(svg, left.x, joint.y, right.x, joint.y);
    } else {
      line(svg, left.x, left.y, joint.x, left.y);
      line(svg, right.x, right.y, joint.x, right.y);
      line(svg, joint.x, left.y, joint.x, right.y);
    }

    return joint;
  }

  walk(tree);
  return svg;
}

function treeMaxDistance(node) {
  if (!node || node.kind === "Leaf") return 0;
  return Math.max(node.distance, treeMaxDistance(node.left), treeMaxDistance(node.right));
}

function line(svg, x1, y1, x2, y2) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "line");
  path.setAttribute("x1", x1.toFixed(2));
  path.setAttribute("y1", y1.toFixed(2));
  path.setAttribute("x2", x2.toFixed(2));
  path.setAttribute("y2", y2.toFixed(2));
  svg.append(path);
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function colorFor(value, min, max) {
  if (value <= 0 || max <= min) return "#d7d9dc";
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const hue = 260 - t * 210;
  const lightness = 24 + t * 42;
  return `hsl(${hue}, 72%, ${lightness}%)`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
