"""Interval grouping and hierarchical segmentation."""
from bisect import bisect_left, bisect_right
from heapq import heappop, heappush
from itertools import pairwise
import hashlib
import uuid

import numpy as np
from anytree import Node

from midi_data import TPB


def _shape_class_uuid_for_members(shape_members) -> str:
    """为一组相似片段生成**稳定**的 uuid 字符串。

    规则：
    - 先把成员片段标准化为 (start,end) 的有序列表（按数值排序）。
    - 对该列表的字符串表示做 sha1，再用 uuid5 生成稳定 uuid。

    说明：
    - uuid5 是基于命名空间+名称的确定性 uuid，保证同一组成员在不同运行中得到相同 id。
    - 这里不再把坐标直接塞进 shape_class，从而避免“坐标即类别名”的耦合。
    """

    members = []
    for it in shape_members or []:
        if isinstance(it, tuple) and len(it) == 2:
            a, b = float(it[0]), float(it[1])
            if b > a:
                members.append((a, b))

    if not members:
        # 没有成员时给一个固定值，避免空串导致不可预期
        return str(uuid.UUID(int=0))

    members = sorted(set(members), key=lambda t: (t[0], t[1]))
    payload = repr(members).encode("utf-8")
    digest = hashlib.sha1(payload).hexdigest()
    return str(uuid.uuid5(uuid.NAMESPACE_URL, digest))


def _union_find_build(groups_items):
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for a, b in groups_items:
        union(a, b)

    # compress
    roots = {}
    for x in list(parent.keys()):
        roots[x] = find(x)
    return roots


def merge_similarity_transitive(merged_info: dict) -> dict:
    """对 merged_info 做相似性传递闭包合并，并扩展 value。

    用户规则：
    - 同一条斜线 (x0,x1,y0,y1) 会在 merged_info 中体现为：key=(x0,x1), value 里包含 (y0,y1)
      因此应认为 (x0,x1) 与 (y0,y1) 属于同一类（无向边）。
    - 在这个“同类边”收集之后，再做相似性传递：a~b 且 b~c => 合并为一类。
    - 最终：对每个 key，value 列表里要包含该同类下的所有线段 (start,end)，并且包含 key 自身。

    返回：merged_info2: Dict[key_segment, List[segment_in_same_class]]
    """

    if merged_info is None:
        return {}

    # 收集所有出现过的线段（key + value 里的 (y0,y1)）
    seg_set = set()
    for k, vlist in merged_info.items():
        if isinstance(k, tuple) and len(k) == 2:
            seg_set.add((float(k[0]), float(k[1])))
        for it in vlist or []:
            if isinstance(it, tuple) and len(it) == 2:
                seg_set.add((float(it[0]), float(it[1])))

    # 建边：key <-> 每个 value 元素（同一斜线的 (x0,x1) 与 (y0,y1)）
    edges = []
    for k, vlist in merged_info.items():
        if not (isinstance(k, tuple) and len(k) == 2):
            continue
        kk = (float(k[0]), float(k[1]))
        edges.append((kk, kk))
        for it in vlist or []:
            if isinstance(it, tuple) and len(it) == 2:
                vv = (float(it[0]), float(it[1]))
                edges.append((kk, vv))
                edges.append((vv, kk))

    roots = _union_find_build(edges)

    groups = {}
    for seg in seg_set:
        r = roots.get(seg, seg)
        groups.setdefault(r, set()).add(seg)

    # 输出：只针对原始 key，value 填充为整个同类集合（包含 key 自身）
    out = {}
    for k in merged_info.keys():
        if not (isinstance(k, tuple) and len(k) == 2):
            continue
        kk = (float(k[0]), float(k[1]))
        r = roots.get(kk, kk)
        members = groups.get(r, {kk})
        out[kk] = sorted(members, key=lambda t: (t[0], t[1]))

    return out


def _strictly_contains(a, b) -> bool:
    return a[0] <= b[0] < b[1] <= a[1] and a != b


def normalize_intervals_with_cut(intervals, keep_overlap=False):
    """对区间集合做规范化：

    交集处理：
    - keep_overlap=False（默认）：若两区间相交但互不包含，则按边界切割，最终得到一组两两不交叠（最多边界相接）的片段。
    - keep_overlap=True：共同保留，遇到相交但不包含时不做切割修改，直接返回原区间集合（去重+排序）。

    返回：sorted list of (start,end)
    """

    intervals = [(float(s), float(e)) for (s, e) in (intervals or []) if float(e) > float(s)]
    intervals = sorted(set(intervals), key=lambda t: (t[0], t[1]))

    if keep_overlap:
        return intervals

    pts = set()
    for s, e in intervals:
        pts.add(float(s))
        pts.add(float(e))
    pts = sorted(pts)

    pieces = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if b <= a:
            continue
        mid = (a + b) / 2.0
        # 如果任何原区间覆盖这个小段，则保留
        covered = False
        for s, e in intervals:
            if float(s) <= mid <= float(e):
                covered = True
                break
        if covered:
            pieces.append((a, b))

    # 合并相邻同起止（防浮点误差）
    merged = []
    for s, e in pieces:
        if not merged:
            merged.append([s, e])
        else:
            ps, pe = merged[-1]
            if abs(ps - s) < 1e-6 and abs(pe - s) < 1e-6:
                merged[-1][1] = e
            elif abs(pe - s) < 1e-6:
                merged[-1][1] = e
            else:
                merged.append([s, e])

    return [(float(s), float(e)) for s, e in merged]


def layout_diag_lines(diag_lines, *, singleton_width=0, frame_width=0):
    """将对角线段投影为横向时间区间，并按规则分配到尽量靠上的多条轨道。

    输入: diag_lines = [(x0,x1,y0,y1), ...]
    输出: [(start, end, y_level), ...]

    规则:
    1. y_level 越小越靠上。
    2. 任意有交集的线条，长的优先占用更靠上的轨道（通过按长度降序贪心放置实现）。
    3. 指定格宽时，从匹配格中心向两侧扩半格，得到真实时间边界。

    额外信息记录：
    - 统计相同 (start, end) 的斜线来自哪些 (y0, y1)，记录为字典：
      { (start,end): [(y0,y1), ...] }
    """

    intervals = []
    merged_dict = {}
    seen = set()

    for (x0, x1, y0, y1) in diag_lines or []:
        s = float(min(x0, x1))
        e = float(max(x0, x1))
        if e <= s and singleton_width <= 0:
            continue

        # 不考虑 SSM 主对角线：x 区间与 y 区间相同的情况（self-similarity）
        ys = float(min(y0, y1))
        ye = float(max(y0, y1))
        if abs(s - ys) < 1e-6 and abs(e - ye) < 1e-6:
            continue

        target = (float(y0), float(y1))
        half = (singleton_width if e == s else frame_width) / 2
        if half:
            s, e = s - half, e + half
            target = (target[0] - half, target[1] + half)
        key = (s, e)
        merged_dict.setdefault(key, []).append(target)

        if key in seen:
            continue
        seen.add(key)
        intervals.append((s, e, e - s))

    intervals.sort(key=lambda t: (-t[2], t[0]))

    lanes = []
    placed = []

    for start, end, _ in intervals:
        for index, lane in enumerate(lanes):
            insert = bisect_left(lane, (start, end))
            if insert and lane[insert - 1][1] > start:
                continue
            if insert < len(lane) and lane[insert][0] < end:
                continue
            lane.insert(insert, (start, end))
            break
        else:
            index = len(lanes)
            lanes.append([(start, end)])
        placed.append((start, end, index))

    return placed, merged_dict


def _child_gaps(parent):
    cursor = parent.start
    for start, end in sorted((child.start, child.end) for child in parent.children):
        if start > cursor:
            yield cursor, start
        cursor = max(cursor, end)
    if cursor < parent.end:
        yield cursor, parent.end


def _fill_bottom_layer(root, midi_name):
    """Cover each interval missing from the leaf layer once."""
    if root.is_leaf:
        if root.end > root.start and not hasattr(root, "leaf_class"):
            root.leaf_class = "fill"
        return
    events = {root.start: 0, root.end: 0}
    parents = []
    for order, node in enumerate((root, *root.descendants)):
        start, end = max(root.start, node.start), min(root.end, node.end)
        if end <= start:
            continue
        events.setdefault(start, 0)
        events.setdefault(end, 0)
        if node is not root and node.is_leaf:
            events[start] += 1
            events[end] -= 1
        else:
            parents.append((start, node.end - node.start, order, end, node))

    candidates = iter(sorted(parents))
    candidate = next(candidates, None)
    active = []
    pending = []
    leaf_count = 0
    for start, end in pairwise(sorted(events)):
        leaf_count += events[start]
        while candidate is not None and candidate[0] <= start:
            heappush(active, candidate[1:])
            candidate = next(candidates, None)
        while active and active[0][2] <= start:
            heappop(active)
        if leaf_count:
            continue

        parent = active[0][3]
        if pending and pending[-1][0] is parent and pending[-1][2] == start:
            pending[-1] = (parent, pending[-1][1], end)
        else:
            pending.append((parent, start, end))

    for idx, (parent, start, end) in enumerate(pending, 1):
        level = parent.level + 1
        Node(f"{midi_name}-fill-{level}-{idx}", parent=parent,
             start=start, end=end, level=level, idx=idx, shape_class="fill")


def build_hline_tree(diag_hlines_f, merged_info_f, midi_name: str, midi_tick_end: int,
                    pr: np.ndarray | None = None,
                    unique_min_len_tick: int = 4 * TPB,
                    fill_min_len_tick: int = 4 * TPB,
                    include_orphan_merged_segments: bool = True,
                    overlap_policy: str = "cut"):
    """按严格的时间区间包含关系组织匹配和补齐片段。

    节点编号：midi名-层数-层中顺序
    """

    merged_sim = merge_similarity_transitive(merged_info_f)

    # 取横线区间（已过滤）
    hlines = [(float(s), float(e), int(ylv)) for (s, e, ylv) in (diag_hlines_f or [])]

    # 把 merged_sim 中“只出现在 value 的片段”（例如 [420,780]）也加入到候选节点里。
    # level：
    # - 若该片段本身出现在 diag_hlines_f，则用其 ylv
    # - 否则使用 max_level+1（作为更深一层的候选节点，不影响原有横线层级）
    if include_orphan_merged_segments:
        hline_level_map = {(float(s), float(e)): int(ylv) for (s, e, ylv) in (diag_hlines_f or [])}
        max_level = max(hline_level_map.values()) if hline_level_map else 0

        all_segments = set(hline_level_map.keys())
        for members in merged_sim.values():
            for seg in members or []:
                if isinstance(seg, tuple) and len(seg) == 2:
                    ss, ee = float(seg[0]), float(seg[1])
                    if ee > ss:
                        all_segments.add((ss, ee))

        hlines = []
        for (ss, ee) in sorted(all_segments, key=lambda t: (t[0], t[1])):
            lvl = hline_level_map.get((ss, ee), max_level + 1)
            hlines.append((float(ss), float(ee), int(lvl)))

    # 初始排序：优先处理长区间，确保父节点先存在
    hlines.sort(key=lambda t: (-(t[1] - t[0]), t[0]))

    root = Node(f"{midi_name}-root", start=0.0, end=float(midi_tick_end), level=-1, idx=0, shape_class="root")
    level_counters = {}

    class_by_segment = {}
    for members in merged_sim.values():
        if members and members[0] not in class_by_segment:
            class_by_segment.update(dict.fromkeys(members, _shape_class_uuid_for_members(members)))
    temp_nodes = []
    root_bounds = (root.start, root.end)
    seen_bounds = set()
    for (s, e, lvl) in hlines:
        bounds = (max(s, root.start), min(e, root.end))
        if not _strictly_contains(root_bounds, bounds) or bounds in seen_bounds:
            continue
        seen_bounds.add(bounds)
        level_counters.setdefault(lvl, 0)
        level_counters[lvl] += 1
        node_id = f"{midi_name}-{lvl}-{level_counters[lvl]}"

        shape_class = class_by_segment.get((s, e))
        if shape_class is None:
            shape_class = _shape_class_uuid_for_members([(s, e)])

        n = Node(node_id, start=bounds[0], end=bounds[1],
                 level=lvl, idx=level_counters[lvl], shape_class=shape_class)
        temp_nodes.append(n)

    # Process longer intervals first. The shortest strict container is the parent.
    temp_nodes.sort(key=lambda node: (-(node.end - node.start), node.start))
    attached = [root]
    for node in temp_nodes:
        bounds = (node.start, node.end)
        node.parent = min((parent for parent in attached
                           if _strictly_contains((parent.start, parent.end), bounds)),
                          key=lambda parent: parent.end - parent.start)
        attached.append(node)

    def uncovered_parts(start, end, ancestor_count):
        index = bisect_right(boundaries, start) - 1
        open_start = None
        while start < end:
            if coverage[index] > ancestor_count:
                if open_start is not None:
                    yield open_start, start
                    open_start = None
            elif open_start is None:
                open_start = start
            index += 1
            start = min(end, boundaries[index])
        if open_start is not None:
            yield open_start, end

    def fill_gaps(parent_node, ancestor_count):
        if parent_node.is_leaf:
            return

        level = parent_node.level + 1
        fill_idx = 0
        for gap_start, gap_end in _child_gaps(parent_node):
            for start, end in uncovered_parts(gap_start, gap_end, ancestor_count):
                start_tick = max(0, min(round(start), pr.shape[1]))
                end_tick = max(0, min(round(end), pr.shape[1]))
                if end_tick <= start_tick or end_tick - start_tick < fill_min_len_tick:
                    continue
                if not np.any(pr[:, start_tick:end_tick] > 0):
                    continue
                fill_idx += 1
                Node(f"{midi_name}-fill-{level}-{fill_idx}", parent=parent_node,
                     start=start, end=end, level=level, idx=fill_idx, shape_class="fill")

    if pr is not None and pr.ndim == 2 and unique_min_len_tick > 0:
        # Every match lies within a root child, so their union defines the unmatched gaps.
        for idx, (start, end) in enumerate(_child_gaps(root), 1):
            start_tick = max(0, min(round(start), pr.shape[1]))
            end_tick = max(0, min(round(end), pr.shape[1]))
            if end_tick - start_tick < unique_min_len_tick:
                continue
            if not np.any(pr[:, start_tick:end_tick] > 0):
                continue
            if root.is_leaf:
                root.leaf_class = "unique"
            else:
                Node(f"{midi_name}-unique-{idx}", parent=root,
                     start=start, end=end, level=0, idx=idx, shape_class="unique")

    if pr is None:
        return root, merged_sim
    if fill_min_len_tick <= 0:
        _fill_bottom_layer(root, midi_name)
        return root, merged_sim

    # A candidate gap is already covered by its matched ancestors. Coverage
    # above that baseline means another branch has a match within the gap.
    events = {root.start: 0, root.end: 0}
    for node in temp_nodes:
        events[node.start] = events.get(node.start, 0) + 1
        events[node.end] = events.get(node.end, 0) - 1
    boundaries = sorted(events)
    coverage = []
    count = 0
    for tick in boundaries:
        count += events[tick]
        coverage.append(count)

    pending = [(root, 0)]
    while pending:
        node, ancestor_count = pending.pop()
        if node.shape_class not in ("root", "unique", "fill"):
            ancestor_count += 1
        children = node.children
        fill_gaps(node, ancestor_count)
        pending.extend((child, ancestor_count) for child in reversed(children))

    return root, merged_sim
