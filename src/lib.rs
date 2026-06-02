use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
struct InputDataset {
    sheets: Vec<InputSheet>,
    options: Options,
}

#[derive(Debug, Deserialize)]
struct InputSheet {
    name: String,
    columns: Vec<String>,
    rows: Vec<InputRow>,
}

#[derive(Debug, Deserialize)]
struct InputRow {
    label: String,
    values: Vec<f64>,
}

#[derive(Debug, Deserialize)]
struct Options {
    all_sheets: bool,
    background_suffix: String,
    exclude_suffix: String,
    cutoff_multiplier: f64,
    cluster_distance: f64,
}

#[derive(Debug, Serialize)]
struct AnalysisResult {
    columns: Vec<String>,
    rows: Vec<OutputRow>,
    representatives: Vec<Representative>,
    row_order: Vec<usize>,
    column_order: Vec<usize>,
    row_tree: TreeNode,
    column_tree: TreeNode,
    stats: Stats,
}

#[derive(Debug, Deserialize)]
struct ClusterInput {
    matrix: Vec<Vec<f64>>,
}

#[derive(Debug, Serialize)]
struct ClusterResult {
    order: Vec<usize>,
    tree: TreeNode,
}

#[derive(Debug, Serialize)]
struct OutputRow {
    label: String,
    original_label: String,
    values: Vec<f64>,
    log_values: Vec<f64>,
    masked_log_values: Vec<f64>,
    cutoffs: Vec<f64>,
    cluster: usize,
}

#[derive(Debug, Serialize)]
struct Representative {
    cluster: usize,
    label: String,
}

#[derive(Debug, Serialize)]
struct Stats {
    rows_loaded: usize,
    rows_plotted: usize,
    columns: usize,
    background_rows: usize,
    min_nonzero_log: f64,
    max_log: f64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum TreeNode {
    Leaf {
        index: usize,
    },
    Branch {
        left: Box<TreeNode>,
        right: Box<TreeNode>,
        distance: f64,
    },
}

#[derive(Clone)]
struct RowData {
    label: String,
    original_label: String,
    values: Vec<f64>,
    cutoffs: Vec<f64>,
}

#[wasm_bindgen]
pub fn analyze_dataset(input: JsValue) -> Result<JsValue, JsValue> {
    let dataset: InputDataset = serde_wasm_bindgen::from_value(input)
        .map_err(|err| JsValue::from_str(&format!("Could not read dataset: {err}")))?;
    let result = analyze(dataset).map_err(|err| JsValue::from_str(&err))?;
    serde_wasm_bindgen::to_value(&result)
        .map_err(|err| JsValue::from_str(&format!("Could not serialize result: {err}")))
}

#[wasm_bindgen]
pub fn cluster_matrix(input: JsValue) -> Result<JsValue, JsValue> {
    let input: ClusterInput = serde_wasm_bindgen::from_value(input)
        .map_err(|err| JsValue::from_str(&format!("Could not read matrix: {err}")))?;
    if input.matrix.is_empty() {
        return Err(JsValue::from_str("Cannot cluster an empty matrix."));
    }

    let width = input.matrix[0].len();
    if input.matrix.iter().any(|row| row.len() != width) {
        return Err(JsValue::from_str("Matrix rows must all have the same length."));
    }

    let tree = hierarchical_cluster(&input.matrix);
    let result = ClusterResult {
        order: leaf_order(&tree),
        tree: serialize_tree(&tree),
    };
    serde_wasm_bindgen::to_value(&result)
        .map_err(|err| JsValue::from_str(&format!("Could not serialize cluster: {err}")))
}

fn analyze(dataset: InputDataset) -> Result<AnalysisResult, String> {
    if dataset.sheets.is_empty() {
        return Err("No sheets were provided.".to_string());
    }

    let columns = dataset.sheets[0].columns.clone();
    if columns.is_empty() {
        return Err("The selected sheet has no numeric columns.".to_string());
    }

    let mut rows = Vec::new();
    let mut rows_loaded = 0;
    let mut background_rows = 0;
    let background_suffixes = parse_suffixes(&dataset.options.background_suffix);
    let exclude_suffixes = parse_suffixes(&dataset.options.exclude_suffix);

    if background_suffixes.is_empty() {
        return Err("At least one background suffix is required.".to_string());
    }
    if exclude_suffixes.is_empty() {
        return Err("At least one exclude suffix is required.".to_string());
    }

    for sheet in &dataset.sheets {
        if sheet.columns != columns {
            return Err(format!(
                "Sheet '{}' has different columns from the first selected sheet.",
                sheet.name
            ));
        }

        let backgrounds = background_signal(sheet, &background_suffixes)?;
        background_rows += sheet
            .rows
            .iter()
            .filter(|row| label_ends_with_any(&row.label, &background_suffixes))
            .count();

        for row in &sheet.rows {
            rows_loaded += 1;
            if label_ends_with_any(&row.label, &exclude_suffixes) {
                continue;
            }

            let label = if dataset.options.all_sheets {
                format!("{}_{}", sheet.name, row.label)
            } else {
                row.label.clone()
            };
            let values = row
                .values
                .iter()
                .zip(backgrounds.iter())
                .map(|(value, background)| value - background)
                .collect::<Vec<_>>();
            let cutoffs = backgrounds
                .iter()
                .map(|background| background * dataset.options.cutoff_multiplier)
                .collect::<Vec<_>>();

            rows.push(RowData {
                label,
                original_label: row.label.clone(),
                values,
                cutoffs,
            });
        }
    }

    if rows.is_empty() {
        return Err("No rows remain after excluding background/control rows.".to_string());
    }

    let log_values = rows
        .iter()
        .map(|row| row.values.iter().map(|value| log10_floor(*value)).collect())
        .collect::<Vec<Vec<f64>>>();
    let log_cutoffs = rows
        .iter()
        .map(|row| row.cutoffs.iter().map(|value| log10_floor(*value)).collect())
        .collect::<Vec<Vec<f64>>>();
    let masked = log_values
        .iter()
        .zip(log_cutoffs.iter())
        .map(|(values, cutoffs)| {
            values
                .iter()
                .zip(cutoffs.iter())
                .map(|(value, cutoff)| if value >= cutoff { *value } else { 0.0 })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let row_tree = hierarchical_cluster(&masked);
    let row_order = leaf_order(&row_tree);
    let column_matrix = transpose(&masked);
    let column_tree = hierarchical_cluster(&column_matrix);
    let column_order = leaf_order(&column_tree);
    let cluster_labels = flat_clusters(&row_tree, dataset.options.cluster_distance);

    let mut first_by_cluster: HashMap<usize, String> = HashMap::new();
    for row_index in &row_order {
        first_by_cluster
            .entry(cluster_labels[*row_index])
            .or_insert_with(|| rows[*row_index].label.clone());
    }
    let mut representatives = first_by_cluster
        .into_iter()
        .map(|(cluster, label)| Representative { cluster, label })
        .collect::<Vec<_>>();
    representatives.sort_by_key(|rep| rep.cluster);

    let mut min_nonzero_log = f64::INFINITY;
    let mut max_log = f64::NEG_INFINITY;
    for row in &log_values {
        for value in row {
            max_log = max_log.max(*value);
        }
    }
    for row in &masked {
        for value in row {
            if *value > 0.0 {
                min_nonzero_log = min_nonzero_log.min(*value);
            }
        }
    }
    if !min_nonzero_log.is_finite() {
        min_nonzero_log = 0.0;
    }
    if !max_log.is_finite() {
        max_log = 0.0;
    }

    let output_rows = rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| OutputRow {
            label: row.label,
            original_label: row.original_label,
            values: row.values,
            cutoffs: row.cutoffs,
            log_values: log_values[index].clone(),
            masked_log_values: masked[index].clone(),
            cluster: cluster_labels[index],
        })
        .collect();

    Ok(AnalysisResult {
        columns,
        rows: output_rows,
        representatives,
        row_order,
        column_order,
        row_tree: serialize_tree(&row_tree),
        column_tree: serialize_tree(&column_tree),
        stats: Stats {
            rows_loaded,
            rows_plotted: log_values.len(),
            columns: dataset.sheets[0].columns.len(),
            background_rows,
            min_nonzero_log,
            max_log,
        },
    })
}

fn serialize_tree(node: &ClusterNode) -> TreeNode {
    match node {
        ClusterNode::Leaf(index) => TreeNode::Leaf { index: *index },
        ClusterNode::Branch {
            left,
            right,
            distance,
        } => TreeNode::Branch {
            left: Box::new(serialize_tree(left)),
            right: Box::new(serialize_tree(right)),
            distance: *distance,
        },
    }
}

fn parse_suffixes(value: &str) -> Vec<String> {
    value
        .split(|char: char| char == ',' || char == ';' || char.is_whitespace())
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
}

fn label_ends_with_any(label: &str, suffixes: &[String]) -> bool {
    suffixes.iter().any(|suffix| label.ends_with(suffix))
}

fn background_signal(sheet: &InputSheet, suffixes: &[String]) -> Result<Vec<f64>, String> {
    let controls = sheet
        .rows
        .iter()
        .filter(|row| label_ends_with_any(&row.label, suffixes))
        .collect::<Vec<_>>();
    if controls.is_empty() {
        let suffix_list = suffixes.join(", ");
        return Err(format!(
            "Sheet '{}' has no rows ending with any of: {}.",
            sheet.name, suffix_list
        ));
    }

    let mut means = vec![0.0; sheet.columns.len()];
    for row in &controls {
        if row.values.len() != sheet.columns.len() {
            return Err(format!("Row '{}' does not match the column count.", row.label));
        }
        for (index, value) in row.values.iter().enumerate() {
            means[index] += value;
        }
    }

    for value in &mut means {
        *value = (*value / controls.len() as f64).round();
    }
    Ok(means)
}

fn log10_floor(value: f64) -> f64 {
    value.max(1.0).log10()
}

fn transpose(matrix: &[Vec<f64>]) -> Vec<Vec<f64>> {
    if matrix.is_empty() {
        return Vec::new();
    }
    let columns = matrix[0].len();
    (0..columns)
        .map(|column| matrix.iter().map(|row| row[column]).collect())
        .collect()
}

#[derive(Clone)]
enum ClusterNode {
    Leaf(usize),
    Branch {
        left: Box<ClusterNode>,
        right: Box<ClusterNode>,
        distance: f64,
    },
}

fn hierarchical_cluster(matrix: &[Vec<f64>]) -> ClusterNode {
    let mut clusters = matrix
        .iter()
        .enumerate()
        .map(|(index, _)| ActiveCluster {
            members: vec![index],
            node: ClusterNode::Leaf(index),
        })
        .collect::<Vec<_>>();

    if clusters.is_empty() {
        return ClusterNode::Leaf(0);
    }

    while clusters.len() > 1 {
        let mut best = (0, 1, f64::INFINITY);
        for i in 0..clusters.len() {
            for j in (i + 1)..clusters.len() {
                let distance = average_linkage_distance(&clusters[i], &clusters[j], matrix);
                if distance < best.2 {
                    best = (i, j, distance);
                }
            }
        }

        let right = clusters.remove(best.1);
        let left = clusters.remove(best.0);
        let mut members = left.members;
        members.extend(right.members);
        clusters.push(ActiveCluster {
            members,
            node: ClusterNode::Branch {
                left: Box::new(left.node),
                right: Box::new(right.node),
                distance: best.2,
            },
        });
    }

    clusters.remove(0).node
}

struct ActiveCluster {
    members: Vec<usize>,
    node: ClusterNode,
}

fn average_linkage_distance(left: &ActiveCluster, right: &ActiveCluster, matrix: &[Vec<f64>]) -> f64 {
    let mut total = 0.0;
    let mut count = 0;
    for left_index in &left.members {
        for right_index in &right.members {
            total += euclidean(&matrix[*left_index], &matrix[*right_index]);
            count += 1;
        }
    }
    total / count as f64
}

fn euclidean(left: &[f64], right: &[f64]) -> f64 {
    left.iter()
        .zip(right.iter())
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f64>()
        .sqrt()
}

fn leaf_order(node: &ClusterNode) -> Vec<usize> {
    match node {
        ClusterNode::Leaf(index) => vec![*index],
        ClusterNode::Branch { left, right, .. } => {
            let mut values = leaf_order(left);
            values.extend(leaf_order(right));
            values
        }
    }
}

fn flat_clusters(node: &ClusterNode, threshold: f64) -> Vec<usize> {
    let mut labels = vec![0; leaf_order(node).len()];
    let mut next_label = 1;
    assign_clusters(node, threshold, &mut next_label, &mut labels);
    labels
}

fn assign_clusters(
    node: &ClusterNode,
    threshold: f64,
    next_label: &mut usize,
    labels: &mut [usize],
) {
    match node {
        ClusterNode::Leaf(index) => {
            labels[*index] = *next_label;
            *next_label += 1;
        }
        ClusterNode::Branch {
            left,
            right,
            distance,
        } => {
            if *distance <= threshold {
                let label = *next_label;
                *next_label += 1;
                assign_label(node, label, labels);
            } else {
                assign_clusters(left, threshold, next_label, labels);
                assign_clusters(right, threshold, next_label, labels);
            }
        }
    }
}

fn assign_label(node: &ClusterNode, label: usize, labels: &mut [usize]) {
    match node {
        ClusterNode::Leaf(index) => labels[*index] = label,
        ClusterNode::Branch { left, right, .. } => {
            assign_label(left, label, labels);
            assign_label(right, label, labels);
        }
    }
}
