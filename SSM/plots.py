"""Optional Matplotlib views for the original CLI workflow."""
from matplotlib import colormaps
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from midi_data import ASPECT, DF2PR, TPB
from structure import normalize_intervals_with_cut

SSM_DISP_RANGE_TICK = None


def _stable_pastel_color_for_key(key: str, alpha_fill: float = 0.18, alpha_edge: float = 0.75):
    if str(key) == "unique":
        face = (0.7, 0.7, 0.7, float(alpha_fill))
        edge = (0.35, 0.35, 0.35, float(alpha_edge))
        return face, edge

    """为给定 key 生成稳定的浅色(填充/边框)。

    说明：
    - 使用 seaborn 调色板，确保类别数较多时也尽量不重复。
    - 为了稳定性，按 key 的哈希在调色板里取一个索引。

    返回: (face_rgba, edge_rgba)
    """

    import hashlib

    try:
        import seaborn as sns
        palette = sns.color_palette("husl", 256)
    except ImportError:
        # seaborn 不可用时退化到 matplotlib
        palette = [colormaps.get_cmap("tab20")(i)[:3] for i in range(20)]

    key = "" if key is None else str(key)
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    idx = int(h[:8], 16) % len(palette)

    r, g, b = palette[idx]
    face = (float(r), float(g), float(b), float(alpha_fill))
    edge = (float(r), float(g), float(b), float(alpha_edge))
    return face, edge


def _node_color_key(n) -> str:
    """节点归类规则：同种类节点同色；所有 unique 同色。"""

    cls = str(getattr(n, "shape_class", ""))
    if cls == "unique":
        return "unique"
    return cls


def plot_anytree(root, figsize=(14, 8), node_box=True, fontsize=8, show=True):
    """使用 matplotlib 绘制 anytree 树（不依赖 graphviz）。

    采用简单的自顶向下布局：
    - y 表示深度（根在最上）
    - x 按叶子顺序分配，并向上取子树中心

    节点标签默认显示区间与类型，避免控制台树线乱码带来的困扰。
    """

    # 收集节点
    nodes = [root] + list(root.descendants)

    # 叶子
    leaves = [n for n in nodes if len(getattr(n, "children", [])) == 0]
    if len(leaves) == 0:
        leaves = [root]

    # 深度
    def depth(n):
        d = 0
        cur = n
        while getattr(cur, "parent", None) is not None:
            d += 1
            cur = cur.parent
        return d

    depths = {n: depth(n) for n in nodes}
    max_depth = max(depths.values()) if depths else 0

    # 先给叶子分配 x
    x = {}
    for i, leaf in enumerate(leaves):
        x[leaf] = float(i)

    # 后序遍历，给非叶节点 x=孩子均值
    for n in sorted(nodes, key=lambda n: -depths[n]):
        if n in x:
            continue
        ch = list(getattr(n, "children", []))
        if not ch:
            x[n] = float(len(x))
        else:
            x[n] = float(np.mean([x[c] for c in ch]))

    # y 轴向下为负（更直观）
    y = {n: -float(depths[n]) for n in nodes}

    fig, ax = plt.subplots(figsize=figsize)

    # 画边
    for n in nodes:
        for c in getattr(n, "children", []):
            ax.plot([x[n], x[c]], [y[n], y[c]], color="k", linewidth=0.8)

    # 画点+标签
    for n in nodes:
        s = getattr(n, "start", None)
        e = getattr(n, "end", None)
        cls = getattr(n, "shape_class", "")
        lvl = getattr(n, "level", "")

        label = f"[{int(s)},{int(e)}]"
        if cls == "fill":
            label += " fill"
        elif cls == "root":
            label += " root"
        else:
            label += f" L{lvl}"

        face, edge = _stable_pastel_color_for_key(_node_color_key(n))

        ax.scatter(
            [x[n]],
            [y[n]],
            s=26,
            facecolor=face,
            edgecolor=edge,
            linewidths=1.3,
        )
        if node_box:
            ax.text(
                x[n], y[n], label,
                fontsize=fontsize,
                ha="center", va="bottom",
                bbox=dict(boxstyle="round,pad=0.2", fc=face, ec=edge, linewidth=1.0),
            )
        else:
            ax.text(x[n], y[n], label, fontsize=fontsize, ha="center", va="bottom")

    ax.set_axis_off()
    ax.set_title("Segment Tree")
    plt.tight_layout()
    if show:
        plt.show()


def plot_tree_with_midi_slices_anytree(root_node, pr, midi_tick_end=None,
                                      cmap="gray_r", border_width=2,
                                      fig_ratio=(4, 1), max_depth=None,
                                      simplify_text=True, fontsize=8,
                                      show_edges=True, show=True):
    """绘制树结构，并在每个节点位置显示对应的 MIDI 切片（pianoroll 子矩阵）。

    关键约束：
    1) 每一层的“收尾连接总长度”一致，都是全曲：[0, midi_tick_end]
       - 做法：节点的 x 直接取该节点区间中心点在全曲上的归一化位置。
    2) 节点文本简化显示：默认仅显示 [start,end]（tick），fill/root 用简短标记。

    参数:
    - root_node: anytree Node，要求节点具备 start/end（tick）属性。
    - pr: pianoroll (pitch x tick)
    - midi_tick_end: 全曲 tick 长度；None 时默认取 root_node.end 或 pr.shape[1]
    """

    if pr is None or getattr(pr, "ndim", 0) != 2:
        raise ValueError("pr 必须是二维矩阵 (pitch x time)")

    if midi_tick_end is None:
        if getattr(root_node, "end", None) is not None:
            midi_tick_end = int(round(float(root_node.end)))
        else:
            midi_tick_end = int(pr.shape[1])
    midi_tick_end = max(1, int(midi_tick_end))

    # 收集节点（包含 root）
    nodes = [root_node] + list(root_node.descendants)

    if max_depth is None:
        # 最大层数由“真实叶子”决定：任意节点没有子节点（根据包含关系构树后）
        leaves = [n for n in nodes if len(list(getattr(n, "children", []) or [])) == 0]
        if len(leaves) == 0:
            max_depth = max([getattr(n, "depth", 0) for n in nodes])
        else:
            max_depth = max([int(getattr(n, "depth", 0)) for n in leaves])

    # 位置：x=区间中心点(归一化)，y=-depth
    positions = {}
    edges = []

    for n in nodes:
        d = int(getattr(n, "depth", 0))
        if d > max_depth:
            continue
        s = float(getattr(n, "start", 0.0))
        e = float(getattr(n, "end", 0.0))
        c = (s + e) / 2.0
        x = c / float(midi_tick_end)
        y = -float(d)
        positions[n] = (x, y)

    if show_edges:
        for n in positions.keys():
            for c in getattr(n, "children", []) or []:
                if c in positions:
                    edges.append((n, c))

    # 画布：宽度随叶子数量略扩，避免过挤
    n_leaf = len([n for n in positions.keys() if len(getattr(n, "children", []) or []) == 0])
    fig_w = max(10.0, float(n_leaf) * float(fig_ratio[0]) * 0.6)
    fig_h = max(3.0, float(max_depth + 1) * float(fig_ratio[1]) * 2.0)

    fig, ax = plt.subplots(figsize=(fig_w, fig_h))

    # 节点切片绘制
    for n, (x, y) in positions.items():
        s = int(round(float(getattr(n, "start", 0.0))))
        e = int(round(float(getattr(n, "end", 0.0))))
        s = max(0, min(s, pr.shape[1]))
        e = max(0, min(e, pr.shape[1]))
        if e <= s:
            continue

        mat = pr[:, s:e]
        h, w = mat.shape

        # extent：x 方向按时长缩放（相对全曲），保证视觉上“横向总长度=全曲”
        extent_x = float(w) / float(midi_tick_end)
        extent_y = float(h) / 50.0
        extent_y = max(extent_y, 0.08)

        ax.imshow(
            mat,
            extent=(x - extent_x / 2.0, x + extent_x / 2.0, y - extent_y / 2.0, y + extent_y / 2.0),
            cmap=cmap,
            interpolation="nearest",
            origin="lower",
            aspect="auto",
        )

        face, edge = _stable_pastel_color_for_key(_node_color_key(n))

        rect = plt.Rectangle(
            (x - extent_x / 2.0, y - extent_y / 2.0),
            extent_x,
            extent_y,
            linewidth=border_width,
            edgecolor=edge,
            facecolor=face,
        )
        ax.add_patch(rect)

        if simplify_text:
            cls = str(getattr(n, "shape_class", ""))
            if cls == "root":
                name = "root"
            else:
                name = f"[{s},{e}]"
        else:
            name = str(getattr(n, "name", ""))

        ax.text(
            x,
            y + extent_y / 2.0 + 0.05,
            name,
            ha="center",
            va="bottom",
            fontsize=fontsize,
            color="red",
            fontweight="bold",
        )

    # 画边
    if show_edges:
        for a, b in edges:
            x0, y0 = positions[a]
            x1, y1 = positions[b]
            ax.plot([x0, x1], [y0, y1], "k-", lw=1, antialiased=True)

    ax.set_xlim(0.0, 1.0)
    ax.set_ylim(-float(max_depth) - 0.8, 0.6)
    ax.axis("off")
    plt.tight_layout()
    if show:
        plt.show()


def show_pr(pr, disp_xrange=None, title="PR", set_figure=True, aspect=None,
            cmap="gray_r", vmin=0.0, vmax=1.0, high_pitch_on_top=True,
            show_range_in_title=True, close_axis=True, show_xticks=True,
            tick_step=0, tick_label_rotation=45,
            draw_beat_lines=True, beats_per_bar=4,
            beat_line_alpha=0.25, bar_line_alpha=0.35,
            beat_line_ls="--", bar_line_ls="-",
            beat_line_lw=0.8, bar_line_lw=1.2, show=True,
            tpb=TPB):
    """显示单个 PR（图像模式）。"""

    if aspect is None:
        aspect = float(tpb) / 4.0

    if set_figure:
        plt.figure()

    a_full = pr
    total_len = int(a_full.shape[1]) if getattr(a_full, "ndim", 0) == 2 else 0

    x0, x1 = 0, total_len
    a = a_full
    if disp_xrange is not None:
        if isinstance(disp_xrange, tuple):
            x0, x1 = int(disp_xrange[0]), int(disp_xrange[1])
            a = a_full[:, x0:x1]
        elif isinstance(disp_xrange, int):
            x0, x1 = 0, int(disp_xrange)
            a = a_full[:, :x1]

    if high_pitch_on_top:
        a = a[::-1, :]

    if show_range_in_title and total_len > 0:
        title = f"{title} ({x0}:{x1}/{total_len})"

    ax = plt.gca()
    ax.imshow(a, cmap=cmap, aspect=str(aspect), vmin=vmin, vmax=vmax, interpolation="nearest")
    ax.set_title(title)

    # 竖线：每拍虚线、每小节实线（tick 坐标）
    if draw_beat_lines and total_len > 0:
        beat_ticks = np.arange((x0 // int(tpb)) * int(tpb), x1 + 1e-6, int(tpb))
        for t in beat_ticks:
            x = (t - x0) - 0.5
            is_bar = (beats_per_bar > 0) and ((t // int(tpb)) % beats_per_bar == 0)
            ax.axvline(
                x=x,
                color="k",
                alpha=bar_line_alpha if is_bar else beat_line_alpha,
                linestyle=bar_line_ls if is_bar else beat_line_ls,
                linewidth=bar_line_lw if is_bar else beat_line_lw,
            )

    if show_xticks and total_len > 0:
        if tick_step <= 0:
            tick_step = int(tpb) * 4
        xt = np.arange(x0, x1 + 1e-6, tick_step)
        ax.set_xticks(xt - x0)
        ax.set_xticklabels([str(int(t)) for t in xt], rotation=tick_label_rotation)
    else:
        ax.set_xticks([])

    ax.set_yticks([])

    if close_axis:
        ax.axis("off")

    plt.tight_layout()
    if set_figure and show:
        plt.show()


def show_all_pr(pr_or_df_ls, disp_xrange=None, titles=None, aspect=None,
                figsize_per_row=(10, 2.5), high_pitch_on_top=True,
                show_xticks=True, tick_step=0,
                tpb=TPB,
                draw_beat_lines=True, beats_per_bar=4,
                beat_line_alpha=0.25, bar_line_alpha=0.35,
                beat_line_ls="--", bar_line_ls="-",
                beat_line_lw=0.8, bar_line_lw=1.2, show=True):
    """显示多个 PR：每个一行。"""

    n = len(pr_or_df_ls)
    if n == 0:
        return

    first = pr_or_df_ls[0]
    if isinstance(first, pd.DataFrame):
        pr_ls = [DF2PR(df) for df in pr_or_df_ls]
    else:
        pr_ls = pr_or_df_ls

    figsize = (float(figsize_per_row[0]), float(figsize_per_row[1]) * n)
    fig, axs = plt.subplots(n, 1, figsize=figsize, squeeze=False, sharex=True)

    for i, pr in enumerate(pr_ls):
        ax = axs[i, 0]
        title = titles[i] if titles is not None and i < len(titles) else f"PR {i}"

        a_full = pr
        total_len = int(a_full.shape[1]) if getattr(a_full, "ndim", 0) == 2 else 0
        x0, x1 = 0, total_len
        a = a_full
        if disp_xrange is not None:
            if isinstance(disp_xrange, tuple):
                x0, x1 = int(disp_xrange[0]), int(disp_xrange[1])
                a = a_full[:, x0:x1]
            elif isinstance(disp_xrange, int):
                x0, x1 = 0, int(disp_xrange)
                a = a_full[:, :x1]

        if high_pitch_on_top:
            a = a[::-1, :]

        ax.imshow(a, cmap="gray_r", aspect=str(aspect), vmin=0, vmax=1.0, interpolation="nearest")

        if draw_beat_lines and total_len > 0:
            beat_ticks = np.arange((x0 // int(tpb)) * int(tpb), x1 + 1e-6, int(tpb))
            for t in beat_ticks:
                x = (t - x0) - 0.5
                is_bar = (beats_per_bar > 0) and ((t // int(tpb)) % beats_per_bar == 0)
                ax.axvline(
                    x=x,
                    color="k",
                    alpha=bar_line_alpha if is_bar else beat_line_alpha,
                    linestyle=bar_line_ls if is_bar else beat_line_ls,
                    linewidth=bar_line_lw if is_bar else beat_line_lw,
                )

        ax.set_title(title)
        ax.set_yticks([])

        if i != n - 1:
            ax.set_xticks([])
        else:
            if show_xticks and total_len > 0:
                if tick_step <= 0:
                    tick_step = int(tpb) * 4
                xt = np.arange(x0, x1 + 1e-6, tick_step)
                ax.set_xticks(xt - x0)
                ax.set_xticklabels([str(int(t)) for t in xt], rotation=45)
            else:
                ax.set_xticks([])

    plt.tight_layout()
    if show:
        plt.show()


# ========== Self-Similarity Matrix (SSM) ==========


def _ssm_to_brightness(ssm_m: np.ndarray) -> np.ndarray:
    """将 SSM 值映射到显示“像素值” [0,1]。

    约定：
    - 1 为黑色
    - 0 为白色

    因此这里输出的是“黑度”(ink)，而不是传统意义的 brightness。

    - NCC: 取值约 [-1,1]，先映射为 brightness=(x+1)/2，再取 1-brightness
    - SAD-sim: 已是 brightness∈(0,1]，取 1-brightness
    """

    finite = np.isfinite(ssm_m)
    if not np.any(finite):
        return np.zeros_like(ssm_m, dtype=np.float32)

    v = ssm_m[finite]
    vmin = float(np.nanmin(v))
    vmax = float(np.nanmax(v))

    # NCC
    if vmin < 0 and vmax <= 1.0:
        brightness = (ssm_m + 1.0) / 2.0
        return 1.0 - brightness

    # SAD-sim (0~1)
    if vmin >= 0 and vmax <= 1.0:
        brightness = ssm_m
        return 1.0 - brightness

    # 兜底：按原亮度公式算 brightness，再取反得到 ink
    brightness = 1.0 / (1.0 + ssm_m)
    return 1.0 - brightness


def show_ssm_with_pr(pr, ssm, stride_tick, tick_offset=0, title="SSM", figsize=(20, 20),
                     pr_height=80, pr_width=80, ssm_disp_range=None, value_fmt="{:.2f}",
                     tick_step_segments=4, show_pr_ticks=True, hspace=0.12, wspace=0.04,
                     text_max_dim=100, text_color="black",
                     show_colorbar=True, colorbar_label="brightness",
                     diag_lines=None, diag_hlines=None, show=True):
    """显示单个 SSM：上方显示 PR（x 对齐），左侧显示 PR（y 对齐），右下角显示 SSM。"""

    n = int(ssm.shape[0])
    seg0, seg1 = 0, n

    if ssm_disp_range is not None:
        # ssm_disp_range 使用 tick 单位 (tick_start, tick_end)
        t0, t1 = float(ssm_disp_range[0]), float(ssm_disp_range[1])
        if t1 < t0:
            t0, t1 = t1, t0
        seg0 = int(np.floor(t0 / float(stride_tick)))
        seg1 = int(np.ceil(t1 / float(stride_tick)))
        seg0 = max(0, seg0)
        seg1 = min(n, seg1)

    x0_tick = seg0 * stride_tick
    x1_tick = seg1 * stride_tick

    pr = pr[:, :n * stride_tick]
    pr_show = pr[:, x0_tick:x1_tick]

    if pr_show.shape[0] > pr_height:
        step_h = int(np.ceil(pr_show.shape[0] / pr_height))
        pr_top = pr_show[::step_h, :]
    else:
        pr_top = pr_show

    if pr_show.shape[0] > pr_width:
        step_w = int(np.ceil(pr_show.shape[0] / pr_width))
        pr_left = pr_show[::step_w, :]
    else:
        pr_left = pr_show
    pr_left = pr_left.T

    pr_top = pr_top[::-1, :]

    x_left = tick_offset + x0_tick
    x_right = tick_offset + x1_tick

    tick_step = int(stride_tick) * int(tick_step_segments)
    if tick_step <= 0:
        tick_step = int(stride_tick)
    xt = np.arange(x_left, x_right + 1e-6, tick_step)
    yt = np.arange(x_left, x_right + 1e-6, tick_step)

    fig = plt.figure(figsize=figsize)
    gs = fig.add_gridspec(
        3,
        2,
        height_ratios=[1, 1.5, 4],
        width_ratios=[1.2, 4],
        hspace=hspace,
        wspace=wspace,
        left=0.06,
        right=0.99,
        bottom=0.10,
        top=0.95,
    )

    ax_empty = fig.add_subplot(gs[0, 0])
    ax_pr_left = fig.add_subplot(gs[2, 0])
    ax_ssm = fig.add_subplot(gs[2, 1])
    ax_pr_top = fig.add_subplot(gs[0, 1], sharex=ax_ssm)
    ax_hlines = fig.add_subplot(gs[1, 1], sharex=ax_ssm)

    ax_empty.axis("off")

    ax_pr_top.imshow(
        pr_top,
        cmap="gray_r",
        aspect=ASPECT * 4,
        vmin=0,
        vmax=1.0,
        interpolation="nearest",
        extent=(x_left, x_right, pr_top.shape[0], 0),
    )
    ax_pr_top.set_xlim(x_left, x_right)
    ax_pr_top.set_title(f"PR-x ticks [{x_left}:{x_right})")
    ax_pr_top.set_yticks([])

    beat_ticks = np.arange((x_left // TPB) * TPB, x_right + 1e-6, TPB)
    for t in beat_ticks:
        is_bar = ((t // TPB) % 4 == 0)
        ax_pr_top.axvline(
            x=t,
            color="k",
            alpha=0.3 if is_bar else 0.15,
            linestyle="-" if is_bar else "--",
            linewidth=1.0 if is_bar else 0.6,
        )

    if show_pr_ticks:
        ax_pr_top.set_xticks(xt)
        ax_pr_top.set_xticklabels([str(int(t)) for t in xt], rotation=45)
        ax_pr_top.tick_params(axis="x", top=False, labeltop=False, bottom=True, labelbottom=True)
    else:
        ax_pr_top.set_xticks([])

    ax_hlines.set_xlim(x_left, x_right)
    ax_hlines.set_yticks([])
    if show_pr_ticks:
        ax_hlines.set_xticks(xt)
        ax_hlines.set_xticklabels([str(int(t)) for t in xt], rotation=45)
        ax_hlines.tick_params(axis="x", top=False, labeltop=False, bottom=True, labelbottom=True)
    else:
        ax_hlines.set_xticks([])
    ax_hlines.set_ylabel("")

    for t in beat_ticks:
        is_bar = ((t // TPB) % 4 == 0)
        ax_hlines.axvline(
            x=t,
            color="k",
            alpha=0.25 if is_bar else 0.12,
            linestyle="-" if is_bar else "--",
            linewidth=1.0 if is_bar else 0.6,
        )

    if diag_hlines is not None and len(diag_hlines) > 0:
        nlanes = 0
        for (x0, x1, ylv) in diag_hlines:
            nlanes = max(nlanes, int(ylv) + 1)
            y = int(ylv) * 4
            ax_hlines.plot([x0, x1], [y, y], color="red", linewidth=1.0, solid_capstyle="butt")
        ax_hlines.set_ylim(max((nlanes - 1) * 4 + 0.5, 0.5), -0.5)

    ax_pr_left.imshow(
        pr_left,
        cmap="gray_r",
        aspect=1 / (ASPECT * 4),
        vmin=0,
        vmax=1.0,
        interpolation="nearest",
        extent=(0, pr_left.shape[1], x_right, x_left),
    )
    ax_pr_left.set_ylim(x_right, x_left)
    ax_pr_left.set_title("PR-y")
    ax_pr_left.set_xticks([])
    ax_pr_left.set_yticks(yt)

    for t in beat_ticks:
        is_bar = ((t // TPB) % 4 == 0)
        ax_pr_left.axhline(
            y=t,
            color="k",
            alpha=0.3 if is_bar else 0.15,
            linestyle="-" if is_bar else "--",
            linewidth=1.0 if is_bar else 0.6,
        )

    ssm_show = ssm[seg0:seg1, seg0:seg1]
    mask = np.triu(np.ones_like(ssm_show, dtype=bool), k=1)
    ssm_m = ssm_show.copy().astype(np.float32)
    ssm_m[mask] = np.nan

    bright = _ssm_to_brightness(ssm_m)

    im_ssm = ax_ssm.imshow(
        bright,
        cmap="gray_r",
        vmin=0,
        vmax=1.0,
        interpolation="nearest",
        aspect="auto",
        extent=(x_left, x_right, x_right, x_left),
    )
    ax_ssm.set_xlim(x_left, x_right)
    ax_ssm.set_ylim(x_right, x_left)
    ax_ssm.set_title(title)

    if show_colorbar:
        cax = fig.add_axes([0.065, 0.83, 0.01, 0.12])
        cb = fig.colorbar(im_ssm, cax=cax)
        cb.set_label(colorbar_label)

    if bright.shape[0] <= int(text_max_dim):
        for i in range(bright.shape[0]):
            for j in range(bright.shape[1]):
                if not np.isfinite(ssm_m[i, j]):
                    continue
                cx = x_left + (j + 0.5) * stride_tick
                cy = x_left + (i + 0.5) * stride_tick
                ax_ssm.text(
                    cx,
                    cy,
                    value_fmt.format(float(ssm_m[i, j])),
                    color=text_color,
                    ha="center",
                    va="center",
                    fontsize=7,
                    fontweight="bold",
                )

    for t in beat_ticks:
        is_bar = ((t // TPB) % 4 == 0)
        ax_ssm.axvline(
            x=t,
            color="k",
            alpha=0.3 if is_bar else 0.15,
            linestyle="-" if is_bar else "--",
            linewidth=1.0 if is_bar else 0.6,
        )
        ax_ssm.axhline(
            y=t,
            color="k",
            alpha=0.3 if is_bar else 0.15,
            linestyle="-" if is_bar else "--",
            linewidth=1.0 if is_bar else 0.6,
        )

    ax_ssm.set_xticks(xt)
    ax_ssm.set_yticks(yt)
    ax_ssm.tick_params(axis="x", labelrotation=45)

    if diag_lines is not None:
        for (x0, x1, y0, y1) in diag_lines:
            ax_ssm.plot([x0, x1], [y0, y1], color="red", linewidth=2.0)

    if show:
        plt.show()


def plot_similarity_classes_stacked(pr: np.ndarray,
                                   tree_root,
                                   midi_tick_end: int,
                                   class_names: dict | None = None,
                                   max_classes: int | None = None,
                                   max_segments_per_class: int | None = None,
                                   figsize_per_class=(2.8, 6.0),
                                   cmap="gray_r",
                                   aspect=ASPECT,
                                   label_fs=8,
                                   title="Similarity classes (from tree leaves)",
                                   show=True,
                                   include_fill_leaves: bool = True,
                                   include_pad_leaves: bool = False):
    """按“相似片段类”堆叠绘制每类的片段切片（每个切片是独立子图框）。

    约定：
    - merged_sim: merge_similarity_transitive(...) 的返回值，key 是某个片段 (s,e)，value 是同类所有片段列表。
    - 每个“类”用 value 集合唯一化（tuple(sorted(...))) 作为 class_id。

    展示：
    - 每类一列。
    - 同一类内每个片段一个独立小子图框（子轴），从下到上排列。
    - 每个子图显示该片段的 pianoroll 切片，并标注 tick 范围 "[s,e)"。

    说明：
    - matplotlib 的 subplot 网格需要统一行数，因此会按最大片段数补空白子图。
    """

    if pr is None or getattr(pr, "ndim", 0) != 2:
        raise ValueError("pr 必须是二维矩阵 (pitch x tick)")

    midi_tick_end = int(midi_tick_end)
    if midi_tick_end <= 0:
        midi_tick_end = int(pr.shape[1])

    if tree_root is None:
        return

    # 新的“类别统计”口径：不使用“children 为空”的叶子定义。
    # 因为 unique/pad 等补齐节点可能会把真实相似类节点变成非叶子，从而导致统计错误。
    #
    # 这里改为：统计所有“真实相似类节点”（非 root/fill/unique/pad），按 shape_class 分组。
    nodes = [tree_root] + list(getattr(tree_root, "descendants", []) or [])

    def _is_pad(n):
        return str(getattr(n, "name", "")).endswith("-pad")

    def _is_real_class_node(n):
        cls = str(getattr(n, "shape_class", ""))
        if cls in ("root", "fill", "unique"):
            return False
        if (not include_pad_leaves) and _is_pad(n):
            return False
        return True

    class_map = {}
    for n in nodes:
        if not _is_real_class_node(n):
            continue
        s = float(getattr(n, "start", 0.0))
        e = float(getattr(n, "end", 0.0))
        if e <= s:
            continue
        cls = str(getattr(n, "shape_class", ""))
        class_map.setdefault(cls, []).append((s, e))

    # 是否把 unique 作为一个独立类展示
    # unique：去重统计（同一区间只算一次），避免 pad/重复节点造成重复计数
    for n in nodes:
        if (not include_pad_leaves) and _is_pad(n):
            continue
        if getattr(n, "leaf_class", n.shape_class) != "unique":
            continue
        s = float(getattr(n, "start", 0.0))
        e = float(getattr(n, "end", 0.0))
        if e <= s:
            continue
        class_map.setdefault("unique", []).append((s, e))

    if "unique" in class_map:
        class_map["unique"] = sorted(set(class_map["unique"]), key=lambda t: (t[0], t[1]))

    if not class_map:
        return

    # 类排序：片段数降序，然后按最早开始
    classes = list(class_map.keys())
    classes.sort(key=lambda c: (-len(class_map.get(c, [])), min([t[0] for t in class_map.get(c, [(0.0, 0.0)])])))

    if max_classes is not None:
        classes = classes[: int(max_classes)]

    n_cls = len(classes)
    if n_cls == 0:
        return

    class_segs = []
    max_rows = 0
    for cls in classes:
        segs = sorted(class_map.get(cls, []), key=lambda t: (t[0], t[1]))
        if max_segments_per_class is not None:
            segs = segs[: int(max_segments_per_class)]
        class_segs.append(segs)
        max_rows = max(max_rows, len(segs))

    max_rows = max(1, int(max_rows))

    fig_w = float(figsize_per_class[0]) * n_cls
    fig_h = float(figsize_per_class[1])
    fig, axs = plt.subplots(max_rows, n_cls, figsize=(fig_w, fig_h), squeeze=False)

    # 行从上到下：0..max_rows-1；我们希望“从下往上堆叠”，因此 seg_idx 映射到 row
    for ci, cid in enumerate(classes):
        segs = class_segs[ci]

        cls_name = None
        if class_names is not None:
            cls_name = class_names.get(ci, None) or class_names.get(cid, None)
        if cls_name is None:
            cls_name = f"Class {ci} (#seg={len(cid)})"

        for r in range(max_rows):
            ax = axs[r, ci]
            ax.set_xticks([])
            ax.set_yticks([])

            seg_i = (max_rows - 1) - r  # 让 segs[0] 画在最底下
            if seg_i < 0 or seg_i >= len(segs):
                ax.axis("off")
                continue

            s, e = segs[seg_i]
            s_i = int(round(float(s)))
            e_i = int(round(float(e)))
            s_i = max(0, min(s_i, pr.shape[1]))
            e_i = max(0, min(e_i, pr.shape[1]))
            if e_i <= s_i:
                ax.axis("off")
                continue

            mat = pr[:, s_i:e_i]
            if mat.size == 0:
                ax.axis("off")
                continue

            ax.imshow(
                mat,
                cmap=cmap,
                aspect="auto",
                vmin=0.0,
                vmax=1.0,
                interpolation="nearest",
                origin="lower",
            )
            ax.set_title(f"[{s_i},{e_i})", fontsize=label_fs)

            # 只在最底下一行显示类名，避免占太多空间
            if r == max_rows - 1:
                ax.set_xlabel(cls_name, fontsize=label_fs + 1)

    fig.suptitle(title)
    plt.tight_layout()
    if show:
        plt.show()
