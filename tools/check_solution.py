"""
check_solution.py — 完全独立的解校验器（不复用任何 JS 代码）

用法: python tools/check_solution.py <input.in> <solution.txt>

判定方式刻意做得比求解器本身更"笨"、更保守：
  1. 每条边按固定步长细密取样，逐点做射线法判定是否在边界多边形内；
  2. 再对每条边与边界每条边做严格的线段相交测试；
  3. 不重叠则用分离轴（对每个多边形先做三角剖分再两两 SAT）。

只要有任何一点越界就判定越界，不接受"容差内"的说法。
"""
import sys, math

EPS = 1e-12
TOL = 1e-6   # 距离容差：小于 1e-6 视为接触，不算重叠


def parse(path):
    tok = open(path, 'r', encoding='utf-8', errors='ignore').read().split()
    i = 0
    bn = int(tok[i]); i += 1
    boundary = []
    for _ in range(bn):
        boundary.append((float(tok[i]), float(tok[i + 1]))); i += 2
    gn = int(tok[i]); i += 1
    polys = []
    for _ in range(gn):
        vn = int(tok[i]); i += 1
        pts = []
        for _ in range(vn):
            pts.append((float(tok[i]), float(tok[i + 1]))); i += 2
        polys.append(pts)
    return boundary, polys


def point_in_poly(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


def seg_intersect(a, b, c, d):
    """严格内部相交（端点接触不算）"""
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    den = rx * sy - ry * sx
    if abs(den) < 1e-14:
        return False
    t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den
    u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den
    return 1e-9 < t < 1 - 1e-9 and 1e-9 < u < 1 - 1e-9


def boundary_violation(poly, trans, boundary, samples=64):
    """返回 (越界点数量, 最大越界深度估计)"""
    shifted = [(p[0] + trans[0], p[1] + trans[1]) for p in poly]
    bad = 0
    worst = 0.0
    n = len(shifted)
    for i in range(n):
        a = shifted[i]
        b = shifted[(i + 1) % n]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        k = max(2, min(samples, int(L / 0.02) + 2))
        for s in range(k):
            t = s / (k - 1) if k > 1 else 0.0
            px = a[0] + (b[0] - a[0]) * t
            py = a[1] + (b[1] - a[1]) * t
            if not point_in_poly((px, py), boundary):
                bad += 1
                # 到边界各边的最近距离，作为越界深度
                d = min(_seg_dist(px, py, boundary[j], boundary[(j + 1) % len(boundary)])
                        for j in range(len(boundary)))
                worst = max(worst, d)
    return bad, worst


def _seg_dist(px, py, a, b):
    ax, ay = a; bx, by = b
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    if L2 < 1e-18:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))


def edge_cross(poly, trans, boundary):
    shifted = [(p[0] + trans[0], p[1] + trans[1]) for p in poly]
    cnt = 0
    for i in range(len(shifted)):
        a = shifted[i]; b = shifted[(i + 1) % len(shifted)]
        for j in range(len(boundary)):
            c = boundary[j]; d = boundary[(j + 1) % len(boundary)]
            if seg_intersect(a, b, c, d):
                cnt += 1
    return cnt


def triangulate(pts):
    pts = list(pts)
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
               for i in range(len(pts)))
    if area < 0:
        pts.reverse()
    rem = list(pts)
    tris = []
    guard = len(rem) ** 2
    while len(rem) > 3 and guard > 0:
        guard -= 1
        ok = False
        for i in range(len(rem)):
            p0 = rem[(i - 1) % len(rem)]; p1 = rem[i]; p2 = rem[(i + 1) % len(rem)]
            cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])
            if cr <= 1e-12:
                continue
            good = True
            for j in range(len(rem)):
                if j in (i, (i - 1) % len(rem), (i + 1) % len(rem)):
                    continue
                if _in_tri(rem[j], p0, p1, p2):
                    good = False; break
            if good:
                tris.append((p0, p1, p2)); rem.pop(i); ok = True; break
        if not ok:
            break
    if len(rem) >= 3:
        tris.append((rem[0], rem[1], rem[2]))
    return tris


def _in_tri(p, a, b, c):
    def s(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = s(p, a, b); d2 = s(p, b, c); d3 = s(p, c, a)
    neg = (d1 < -1e-12) or (d2 < -1e-12) or (d3 < -1e-12)
    pos = (d1 > 1e-12) or (d2 > 1e-12) or (d3 > 1e-12)
    return not (neg and pos)


def tri_gap(t1, o1, t2, o2):
    """两个三角形的最大分离间隙（已按边长归一化为真实距离）。
    > 0 表示存在分离轴；< 0 表示沿所有轴都重叠，数值即穿透深度。"""
    best = -1e18
    for A, oa, B, ob in ((t1, o1, t2, o2), (t2, o2, t1, o1)):
        for i in range(3):
            p0 = A[i]; p1 = A[(i + 1) % 3]
            nx = -(p1[1] - p0[1]); ny = (p1[0] - p0[0])
            L = math.hypot(nx, ny) or 1.0
            va = [((p[0] + oa[0]) * nx + (p[1] + oa[1]) * ny) / L for p in A]
            vb = [((p[0] + ob[0]) * nx + (p[1] + ob[1]) * ny) / L for p in B]
            g = max(max(vb) - min(va), max(va) - min(vb))
            if g > best:
                best = g
    return best


def main():
    inp, sol = sys.argv[1], sys.argv[2]
    boundary, polys = parse(inp)
    lines = [l.split() for l in open(sol, encoding='utf-8', errors='ignore').read().splitlines() if l.strip()]
    # 第一行可能是数量
    if len(lines) and len(lines[0]) == 1:
        lines = lines[1:]
    trans = [(float(a), float(b)) for a, b in lines[:len(polys)]]
    if len(trans) != len(polys):
        print('解的行数不对:', len(trans), 'vs', len(polys)); return 1

    total = sum(math.hypot(t[0], t[1]) for t in trans)
    print('多边形数:%d  Σ|trans| = %.6f' % (len(polys), total))

    bad_total = 0
    worst_depth = 0.0
    bad_ids = []
    for i, poly in enumerate(polys):
        bad, depth = boundary_violation(poly, trans[i], boundary)
        cross = edge_cross(poly, trans[i], boundary)
        if bad or cross:
            bad_total += 1
            bad_ids.append((i, bad, cross, depth))
            worst_depth = max(worst_depth, depth)

    if bad_total:
        print('❌ 越界多边形: %d / %d，最大越界深度 ≈ %.4f' % (bad_total, len(polys), worst_depth))
        for i, bad, cross, depth in bad_ids[:12]:
            print('   #%-3d 越界采样点 %-4d 边相交 %-3d 深度 %.4f  trans=(%.3f, %.3f)'
                  % (i, bad, cross, depth, trans[i][0], trans[i][1]))
    else:
        print('✅ 边界: 全部 %d 个多边形都在边界内' % len(polys))

    # 两两重叠
    tris = [triangulate(p) for p in polys]
    boxes = []
    for i, p in enumerate(polys):
        xs = [q[0] for q in p]; ys = [q[1] for q in p]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    hit = 0
    hit_ids = []
    for i in range(len(polys)):
        bi = boxes[i]
        ai = (bi[0] + trans[i][0], bi[1] + trans[i][1], bi[2] + trans[i][0], bi[3] + trans[i][1])
        for j in range(i + 1, len(polys)):
            bj = boxes[j]
            aj = (bj[0] + trans[j][0], bj[1] + trans[j][1], bj[2] + trans[j][0], bj[3] + trans[j][1])
            if ai[2] < aj[0] - 1e-9 or ai[0] > aj[2] + 1e-9 or ai[3] < aj[1] - 1e-9 or ai[1] > aj[3] + 1e-9:
                continue
            # 多边形不重叠 ⇔ 所有三角形对都分离；取最小间隙作为判据
            min_gap = 1e18
            for t1 in tris[i]:
                for t2 in tris[j]:
                    g = tri_gap(t1, trans[i], t2, trans[j])
                    if g < min_gap:
                        min_gap = g
                    if min_gap <= TOL:
                        break
                if min_gap <= TOL:
                    break
            overlapped = min_gap <= TOL
            if overlapped:
                hit += 1
                if len(hit_ids) < 12:
                    hit_ids.append((i, j))
    if hit:
        print('❌ 重叠多边形对: %d  %s' % (hit, hit_ids))
    else:
        print('✅ 重叠: 无')

    ok = (bad_total == 0 and hit == 0)
    print('结论:', '合法' if ok else '不合法')
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main())
