#!/usr/bin/env python3
"""Generate profiling plots from profiler.json (produced by the Type-C compiler)."""

import json
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import pandas as pd

PROFILER_FILE = "profiler.json"
PHASES = ["parsing", "linking", "validating"]
COLORS = {"parsing": "steelblue", "linking": "darkorange", "validating": "seagreen"}

# ── Load ───────────────────────────────────────────────────────────────────────

with open(PROFILER_FILE, encoding="utf-8") as f:
    data = json.load(f)   # { files: [...], summary: {...} }

df = pd.DataFrame(data["files"])   # columns: file, parsing, linking, validating
summary = data["summary"]

for phase in PHASES:
    s = summary[phase]
    print(f"  {phase}: total={s['total']:.1f}ms  max={s['max']:.1f}ms  mean={s['mean']:.2f}ms")

# ── Plot 1: Per-file bar chart for each phase ─────────────────────────────────

fig, axes = plt.subplots(3, 1, figsize=(16, 11), sharex=False)
for ax, phase in zip(axes, PHASES):
    col = COLORS[phase]
    s = summary[phase]
    sorted_df = df.sort_values(phase, ascending=False)
    ax.bar(range(len(sorted_df)), sorted_df[phase], color=col, width=0.8)
    ax.set_ylabel("Time (ms)")
    ax.set_title(
        f"{phase.capitalize()} — {len(sorted_df)} files  |  "
        f"total={s['total']:.1f}ms  max={s['max']:.1f}ms  mean={s['mean']:.2f}ms"
    )
    ax.grid(axis="y", alpha=0.35, linestyle="--")
    ax.yaxis.set_minor_locator(ticker.AutoMinorLocator())
axes[-1].set_xlabel("File index (sorted by time, descending)")
plt.suptitle("Per-file execution times by phase", fontsize=13, fontweight="bold", y=1.01)
plt.tight_layout()
plt.savefig("plot_task_times.png", dpi=150, bbox_inches="tight")
plt.close()
print("Saved plot_task_times.png")

# ── Plot 2: Phase totals (pie) ────────────────────────────────────────────────

totals = {p: summary[p]["total"] for p in PHASES}
fig, ax = plt.subplots(figsize=(6, 6))
_, _, autotexts = ax.pie(
    totals.values(),
    labels=[f"{p}\n({v:.1f}ms)" for p, v in totals.items()],
    colors=[COLORS[p] for p in PHASES],
    autopct="%1.1f%%", startangle=140,
    wedgeprops={"edgecolor": "white", "linewidth": 1.5},
)
for t in autotexts:
    t.set_fontsize(10)
ax.set_title("Total time by phase", fontsize=12, fontweight="bold")
plt.tight_layout()
plt.savefig("plot_phase_split.png", dpi=150)
plt.close()
print("Saved plot_phase_split.png")

# ── Plot 3: Top 20 slowest files per phase ────────────────────────────────────

fig, axes = plt.subplots(1, 3, figsize=(20, 8))
for ax, phase in zip(axes, PHASES):
    top = df.nlargest(20, phase)
    bars = ax.barh(top["file"][::-1], top[phase][::-1], color=COLORS[phase])
    ax.set_title(f"{phase.capitalize()}\ntop 20 slowest files", fontweight="bold")
    ax.set_xlabel("Time (ms)")
    ax.grid(axis="x", alpha=0.35, linestyle="--")
    mx = top[phase].max() if not top.empty else 1
    for bar, val in zip(bars, top[phase][::-1]):
        ax.text(bar.get_width() + mx * 0.01,
                bar.get_y() + bar.get_height() / 2,
                f"{val:.2f}ms", va="center", fontsize=7)
plt.suptitle("Top 20 slowest files per phase", fontsize=13, fontweight="bold")
plt.tight_layout()
plt.savefig("plot_slowest_files.png", dpi=150, bbox_inches="tight")
plt.close()
print("Saved plot_slowest_files.png")

# ── Plot 4: Distribution of per-file times per phase ─────────────────────────

fig, axes = plt.subplots(1, 3, figsize=(15, 4))
for ax, phase in zip(axes, PHASES):
    ax.hist(df[phase], bins=15, color=COLORS[phase], edgecolor="white")
    ax.set_title(f"{phase.capitalize()}")
    ax.set_xlabel("Time (ms)")
    ax.set_ylabel("# files")
    ax.grid(axis="y", alpha=0.35, linestyle="--")
plt.suptitle("Distribution of per-file times per phase", fontsize=13, fontweight="bold")
plt.tight_layout()
plt.savefig("plot_task_distribution.png", dpi=150, bbox_inches="tight")
plt.close()
print("Saved plot_task_distribution.png")

# ── Plot 5: Total time per file (stacked bar, top 30) ────────────────────────

df["total"] = df[PHASES].sum(axis=1)
top30 = df.nlargest(30, "total").sort_values("total")

fig, ax = plt.subplots(figsize=(12, 10))
left = [0.0] * len(top30)
for phase in PHASES:
    vals = top30[phase].tolist()
    ax.barh(top30["file"], vals, left=left, color=COLORS[phase], label=phase)
    left = [l + v for l, v in zip(left, vals)]
ax.set_xlabel("Total time (ms)")
ax.set_title("Top 30 files by total time (stacked by phase)", fontweight="bold")
ax.legend(loc="lower right")
ax.grid(axis="x", alpha=0.35, linestyle="--")
plt.tight_layout()
plt.savefig("plot_stacked_total.png", dpi=150, bbox_inches="tight")
plt.close()
print("Saved plot_stacked_total.png")

# ── Plot 6 & 7: Type inference breakdown ─────────────────────────────────────

ti = data.get("typeInference", [])
if ti:
    ti_df = pd.DataFrame(ti)  # nodeType, calls, totalMs, meanMs

    # Plot 6: Top 25 node types by total inference time
    top25_time = ti_df.nlargest(25, "totalMs")
    fig, ax = plt.subplots(figsize=(12, 8))
    bars = ax.barh(top25_time["nodeType"][::-1], top25_time["totalMs"][::-1], color="mediumpurple")
    ax.set_xlabel("Total inference time (ms, cumulative)")
    ax.set_title("Top 25 AST node types by type inference time\n(cumulative — includes child node inference)", fontweight="bold")
    ax.grid(axis="x", alpha=0.35, linestyle="--")
    mx = top25_time["totalMs"].max()
    for bar, row in zip(bars, top25_time.iloc[::-1].itertuples()):
        ax.text(bar.get_width() + mx * 0.01,
                bar.get_y() + bar.get_height() / 2,
                f"{row.totalMs:.2f}ms  ({row.calls:,} calls)", va="center", fontsize=7)
    plt.tight_layout()
    plt.savefig("plot_type_inference_time.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved plot_type_inference_time.png")

    # Plot 7: Top 25 node types by mean time per call (most expensive per invocation)
    top25_mean = ti_df[ti_df["calls"] >= 5].nlargest(25, "meanMs")
    fig, ax = plt.subplots(figsize=(12, 8))
    bars = ax.barh(top25_mean["nodeType"][::-1], top25_mean["meanMs"][::-1], color="crimson")
    ax.set_xlabel("Mean inference time per call (ms)")
    ax.set_title("Top 25 AST node types by mean inference time per call\n(min 5 calls; excludes cheap high-frequency nodes)", fontweight="bold")
    ax.grid(axis="x", alpha=0.35, linestyle="--")
    mx = top25_mean["meanMs"].max()
    for bar, row in zip(bars, top25_mean.iloc[::-1].itertuples()):
        ax.text(bar.get_width() + mx * 0.01,
                bar.get_y() + bar.get_height() / 2,
                f"{row.meanMs:.3f}ms  ({row.calls:,} calls)", va="center", fontsize=7)
    plt.tight_layout()
    plt.savefig("plot_type_inference_mean.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved plot_type_inference_mean.png")
else:
    print("No typeInference data found — skipping plots 6 & 7.")

print("\nAll plots saved.")
