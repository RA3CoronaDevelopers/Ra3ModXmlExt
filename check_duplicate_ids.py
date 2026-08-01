# -*- coding: utf-8 -*-
"""
check_duplicate_ids.py — RA3 Mod XML 重复 ID 检测工具

从 Data/Mod.xml 开始递归遍历所有 <Include type="all">，解析 DATA:/ART:/AUDIO:
前缀路径，收集所有顶层元素（AssetDeclaration 的直接子元素），并报告相同标签名
+ 相同 id 的重复冲突。

用法:
    python tools/check_duplicate_ids.py --sdk-dir C:\Apps\RA3-MOD-SDK-X
    python tools/check_duplicate_ids.py --sdk-dir C:\Apps\Ra3QuantumCompiler
    python tools/check_duplicate_ids.py --sdk-dir C:\Apps\RA3-MOD-SDK-X --project-dir D:\Mods\CoronaMod\mods\mods\corona
假如路径里有空格，请用引号括起来。
"""

import argparse
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Optional, Dict, Tuple

# ── 命名空间常量 ────────────────────────────────────────────────────
NS_EALA = 'uri:ea.com:eala:asset'
NS_XAI  = 'uri:ea.com:eala:asset:instance'
NS_XI   = 'http://www.w3.org/2001/XInclude'


def strip_ns(tag: str) -> str:
    """去掉 XML 命名空间前缀，返回纯标签名。"""
    if '}' in tag:
        return tag.split('}', 1)[1]
    return tag


def get_ns_uri(tag: str) -> str:
    """提取标签的命名空间 URI（无花括号）。"""
    if '}' in tag:
        return tag.split('}', 1)[0][1:]
    return ''


def norm(p: Path) -> Path:
    """返回标准化的绝对路径。"""
    return p.resolve()

g_cache: Dict[Tuple[str, Optional[Path]], Optional[Path]] = {}
def find_file(source: str, search_paths: dict, current_dir: Optional[Path]) -> Optional[Path]:
    """
    解析 Include/@source 到实际文件路径：
    - DATA:/ART:/AUDIO: 前缀 → 按优先级在各搜索路径中查找
    - 无前缀 → 相对于当前文件所在目录
    对于 ART: 路径，支持 2-letter prefix matching：
      如果源路径无目录分隔符且直接查找失败，提取文件名前 2 个小写字
      母作为子目录再次尝试（如 JUAntiShip → ju/JUAntiShip）。
    返回第一个匹配的文件，未找到返回 None。
    """
    source = source.strip().replace('\\', '/')
    # 前缀统一大写
    for prefix in ("DATA:", "ART:", "AUDIO:"):
        if source[:len(prefix)].upper() == prefix:
            source = prefix + source[len(prefix):]
            break
    if (source, current_dir) in g_cache:
        return g_cache[(source, current_dir)]
    result = _find_no_cache(source, search_paths, current_dir)
    g_cache[(source, current_dir)] = result
    return result

def _find_no_cache(source: str, search_paths: dict, current_dir: Optional[Path]) -> Optional[Path]:
    for prefix in ('DATA:', 'ART:', 'AUDIO:'):
        if source.upper().startswith(prefix):
            rel = source[len(prefix):].lstrip('/')
            # 直接查找
            result = _search_in_paths(rel, search_paths.get(prefix, []))
            if result:
                return result
            # ART: 路径：如果无目录分隔符，尝试 2-letter prefix matching
            if prefix == 'ART:' and '/' not in rel and '\\' not in rel:
                first_two = rel[:2].lower()
                prefixed_rel = f"{first_two}/{rel}"
                result = _search_in_paths(prefixed_rel, search_paths.get(prefix, []))
                if result:
                    return result
            return None
    # 无前缀 → 相对路径
    if current_dir is not None:
        candidate = norm(current_dir / source)
        if candidate.is_file():
            return candidate
    return None


def _search_in_paths(rel_path: str, base_paths: list[Path]) -> Optional[Path]:
    """在多个基路径中依次搜索相对路径，返回第一个存在的文件。"""
    for base in base_paths:
        candidate = norm(base / rel_path)
        if candidate.is_file():
            return candidate
    return None


# ══════════════════════════════════════════════════════════════════════
#  xpointer 简易解析
# ══════════════════════════════════════════════════════════════════════

def parse_xpointer(xpointer_str: str) -> Optional[dict]:
    """
    简易解析 xpointer 表达式，仅支持本项目使用的格式：
        xmlns(n=uri:ea.com:eala:asset) xpointer(/n:ElementName/child::*)
    返回 { 'ns_map': {'n': 'uri:...'}, 'element': 'ElementName' }
    不支持复杂 xpath 时返回 None。
    """
    if not xpointer_str:
        return None
    # 提取 xmlns 映射
    ns_map = {}
    for m in re.finditer(r'xmlns\((\w+)=([^\s)]+)\)', xpointer_str):
        ns_map[m.group(1)] = m.group(2)
    # 提取 xpointer(/prefix:ElementName/child::*)
    m = re.search(r'xpointer\(/(\w+):(\w+)/child::\*\)', xpointer_str)
    if m:
        prefix = m.group(1)
        elem_name = m.group(2)
        return {'ns_map': ns_map, 'element': elem_name, 'prefix': prefix}
    return None


def resolve_xpointer_target(root: ET.Element, xpointer_info: dict) -> list[ET.Element]:
    """
    根据解析后的 xpointer 信息，从已解析的 XML 树中找到对应元素并返回其子元素。
    """
    prefix = xpointer_info.get('prefix', '')
    elem_name = xpointer_info.get('element', '')
    ns_map = xpointer_info.get('ns_map', {})
    ns_uri = ns_map.get(prefix, NS_EALA)
    # 构造带命名空间的标签名
    target_tag = f'{{{ns_uri}}}{elem_name}'
    # 寻找匹配元素
    for elem in root.iter():
        if elem.tag == target_tag:
            return list(elem)
    return []


# ══════════════════════════════════════════════════════════════════════
#  核心检测器
# ══════════════════════════════════════════════════════════════════════

class DuplicateIdChecker:
    """
    从 Mod.xml 出发递归遍历 Include 树，收集顶层元素，报告重复 ID 冲突。
    """

    def __init__(self, sdk_dir: Path, project_dir: Path, cwd: Optional[Path] = None):
        self.sdk_dir = norm(sdk_dir)
        self.project_dir = norm(project_dir)
        self._cwd = norm(cwd) if cwd else self.project_dir

        # ── 自动推断搜索路径 ──
        # 从 CLI 命令推导的结构：
        #   project_dir          = D:\Mods\CoronaMod\mods\mods\corona
        #   project_dir.parent   = D:\Mods\CoronaMod\mods\mods
        #   project_dir.parent.parent = D:\Mods\CoronaMod\mods
        shared = self.project_dir.parent.parent   # D:\Mods\CoronaMod\mods
        mods   = self.project_dir.parent          # D:\Mods\CoronaMod\mods\mods

        pj_data  = self.project_dir / 'Data'
        pj_art1  = self.project_dir / 'Art1'
        pj_art   = self.project_dir / 'Art'
        pj_aud1  = self.project_dir / 'Audio1'
        pj_aud   = self.project_dir / 'Audio'
        sdk_art  = self.sdk_dir / 'Art'
        sdk_aud  = self.sdk_dir / 'Audio'
        sdk_sage = self.sdk_dir / 'SageXml'

        self._search_paths: dict[str, list[Path]] = {
            'DATA:':  [sdk_dir, pj_data, mods, sdk_sage],
            'ART:':   [sdk_dir, pj_art1, pj_art, mods, sdk_art],
            'AUDIO:': [sdk_dir, pj_aud1, pj_aud, mods, sdk_aud],
        }
        # SageXml 路径：用于标记来自 SageXml 的元素
        self._sagexml_dir = sdk_sage
        # SDK Art 路径：用于标记来自 SDK Art 的元素
        self._sdk_art_dir = sdk_art

        # 状态
        self._visited: set[str] = set()        # 已访问过的文件（绝对路径）
        self.manifest: list[tuple] = []         # (tag, id, rel_path, line)
        self.dep_tree: list[tuple] = []         # (depth, ref_src, resolved_path)
        self.not_found: list[tuple] = []        # (source, parent_file)
        self.errors: list[str] = []
        self._sagexml_files: set[str] = set()  # SageXml 下的文件（用于冲突过滤）

    # ── 公开入口 ──────────────────────────────────────────────────────

    def run(self) -> int:
        """
        执行完整检测流程。
        返回: 0=正常, 1=发现冲突, 2=严重错误
        """
        t_start = time.perf_counter()
        
        mod_xml = self.project_dir / 'Data' / 'Mod.xml'
        if not mod_xml.is_file():
            print(f"❌  Mod.xml 未找到: {mod_xml}", file=sys.stderr)
            return 2

        print(f"🔍  起始文件: {mod_xml}")
        print(f"📁  项目目录: {self.project_dir}")
        print(f"📁  SDK 目录 : {self.sdk_dir}")
        print(f"📁  工作目录 : {self._cwd}")
        print()

        for prefix in ('DATA:', 'ART:', 'AUDIO:'):
            paths = self._search_paths.get(prefix, [])
            markers = [f"{' ✔' if p.is_dir() else ''}" for p in paths]
            lines = [f"      {i}. {p}{m}" for i, (p, m) in enumerate(zip(paths, markers), 1)]
            print(f"    {prefix} 搜索路径:")
            for l in lines:
                print(l)
        print()

        self._process_file(mod_xml, depth=0, reference='Mod.xml')

        # ── 冲突检测 ──
        # 仅在模组文件（非 SageXml）之间检测冲突。
        # SageXml 中的同名元素是引擎基础，被模组覆盖是正常行为。
        grouped: dict[tuple[str, str], list] = defaultdict(list)
        for tag, eid, src, line in self.manifest:
            # 跳过来自 SageXml 的条目
            if src in self._sagexml_files:
                continue
            grouped[(tag, eid)].append((src, line))
        conflicts = {k: v for k, v in grouped.items() if len(v) > 1}

        # 统计 SageXml 覆盖信息（用于报告）
        sagexml_overrides = 0
        sagexml_only = set()
        for tag, eid, src, line in self.manifest:
            if src in self._sagexml_files:
                sagexml_only.add((tag, eid))
        if sagexml_only:
            # 检查这些 SageXml 提供的 id 是否被模组覆盖
            mod_ids = set()
            for tag, eid, src, line in self.manifest:
                if src not in self._sagexml_files:
                    mod_ids.add((tag, eid))
            sagexml_overrides = len(sagexml_only & mod_ids)

        # ── 输出 ──
        self._print_dep_tree()
        self._print_manifest()
        self._print_conflicts(conflicts)
        self._print_not_found()
        self._print_errors()

        if conflicts:
            print(f"\n⚠️  发现 {len(conflicts)} 组重复 ID（相同标签名 + 相同 id）")
        else:
            print("\n✅ 未发现模组内的重复 ID 冲突")
        if sagexml_overrides:
            print(f"📌 模组覆盖了 {sagexml_overrides} 个来自 SageXml 的 id（正常行为）")

        t_elapsed = time.perf_counter() - t_start
        if t_elapsed < 60:
            print(f"⏱  耗时: {t_elapsed:.2f} 秒")
        else:
            minutes = int(t_elapsed // 60)
            seconds = t_elapsed % 60
            print(f"⏱  耗时: {minutes} 分 {seconds:.1f} 秒")
        print()
        return 1 if conflicts else 0

    # ── 文件处理 ──────────────────────────────────────────────────────

    def _process_file(self, file_path: Path, depth: int, reference: str):
        """解析一个 XML 文件：收集顶层元素，递归处理 Includes。"""
        resolved = norm(file_path)
        key = str(resolved)
        if key in self._visited:
            return
        self._visited.add(key)

        # 记录依赖
        try:
            rel = resolved.relative_to(self.project_dir)
        except ValueError:
            rel = resolved
        self.dep_tree.append((depth, reference, str(rel)))

        # 标记是否来自 SageXml
        is_sagexml = self._sagexml_dir in resolved.parents\
                     or str(resolved).startswith(str(self._sagexml_dir))
        if is_sagexml:
            self._sagexml_files.add(str(rel))
        # 检测是否来自 SDK Art
        is_sdk_art = self._sdk_art_dir in resolved.parents\
                     or str(resolved).startswith(str(self._sdk_art_dir))
        if is_sdk_art:
            # 检测文件大小是否小于等于 75 字节（空 XML）
            try:
                if resolved.stat().st_size <= 75:
                    return
            except Exception:
                pass
            self._sagexml_files.add(str(rel))  # 也视为基础资源，避免冲突

        root = self._parse(resolved)
        if root is None:
            return

        local = strip_ns(root.tag)
        if local != 'AssetDeclaration':
            self.errors.append(
                f"  跳过非 AssetDeclaration 根元素: {rel} (根={local})"
            )
            return

        # 遍历 AssetDeclaration 的直接子元素
        for child in root:
            child_local = strip_ns(child.tag)
            ns_uri = get_ns_uri(child.tag)

            # ── <Includes> ──
            if child_local == 'Includes':
                self._process_includes(child, resolved, depth)
                continue

            # ── <xi:include> 在顶层 ──
            if child_local == 'include' and ns_uri == NS_XI:
                self._process_xi_include(child, resolved, depth)
                continue

            # ── <Tags> 跳过 ──
            if child_local == 'Tags':
                continue

            # ── 顶层内容元素 ──
            element_id = child.get('id')
            if element_id:
                line = getattr(child, 'sourceline', None)
                self.manifest.append((child_local, element_id, str(rel), line))

    def _process_includes(self, includes_elem, current_file: Path, depth: int):
        """处理 <Includes> 块中的 <Include> 元素。"""
        for inc in includes_elem:
            local = strip_ns(inc.tag)
            if local != 'Include':
                continue
            if inc.get('type') != 'all':
                continue
            source = inc.get('source')
            if not source:
                continue

            resolved = find_file(source, self._search_paths, current_file.parent)
            if resolved and resolved.is_file():
                self._process_file(resolved, depth + 1, reference=source)
            else:
                self.not_found.append((source, str(current_file)))

    def _process_xi_include(self, xi_elem, current_file: Path, depth: int):
        """
        处理位于 AssetDeclaration 顶层的 <xi:include>。
        解析 xpointer（如有），读取目标文件并提取可能成为顶层元素的子元素。
        """
        href = xi_elem.get('href')
        if not href:
            return
        resolved = find_file(href, self._search_paths, current_file.parent)
        if not resolved or not resolved.is_file():
            self.not_found.append((f"xi:{href}", str(current_file)))
            return

        try:
            rel = resolved.relative_to(self.project_dir)
        except ValueError:
            rel = resolved

        # 避免重复处理
        key = str(norm(resolved))
        if key in self._visited:
            return
        self._visited.add(key)

        self.dep_tree.append((depth, f"xi:{href}", str(rel)))

        root = self._parse(resolved)
        if root is None:
            return

        # 获取 xpointer
        xp_str = xi_elem.get('xpointer', '')
        xp_info = parse_xpointer(xpointer_str=xp_str)

        if xp_info:
            # xpointer 指向某个容器元素，取其子元素
            target_children = resolve_xpointer_target(root, xp_info)
            candidates = target_children
        else:
            # 没有 xpointer 或无法解析，取根元素的直接子元素
            candidates = list(root)

        # 将候选项作为顶层元素处理
        for elem in candidates:
            elem_local = strip_ns(elem.tag)
            # 跳过非内容元素
            if elem_local in ('Tags', 'Includes'):
                continue
            element_id = elem.get('id')
            if element_id:
                line = getattr(elem, 'sourceline', None)
                self.manifest.append((elem_local, element_id, str(rel), line))

    # ── 辅助方法 ──────────────────────────────────────────────────────

    def _parse(self, file_path: Path) -> Optional[ET.Element]:
        """解析 XML 文件，返回根元素。

        自动处理常见编码问题：当 XML 声明 encoding 与实际编码不匹配时
        （例如声明 us-ascii 但文件实际为 UTF-8），尝试自动修正。
        """
        # 第一次尝试：正常解析
        try:
            tree = ET.parse(file_path)
            return tree.getroot()
        except ET.ParseError as e:
            error_msg = str(e)
            # 如果是不规范的 token 错误，可能是编码声明与实际编码不符
            if 'not well-formed (invalid token)' in error_msg:
                try:
                    with open(file_path, 'rb') as f:
                        raw = f.read()
                    # 修复常见的错误编码声明：us-ascii → utf-8
                    raw = raw.replace(b'us-ascii', b'utf-8')
                    raw = raw.replace(b'US-ASCII', b'UTF-8')
                    raw = raw.replace(b'us-ASCII', b'utf-8')
                    tree = ET.fromstring(raw)
                    return tree
                except Exception:
                    pass
            self.errors.append(f"  XML 解析错误: {file_path} — {e}")
            return None
        except Exception as e:
            self.errors.append(f"  读取失败: {file_path} — {e}")
            return None

    # ── 输出方法 ──────────────────────────────────────────────────────

    def _print_dep_tree(self):
        """打印 Include 依赖树。"""
        print("═" * 60)
        print("📂  Include 依赖树")
        print("═" * 60)
        # 只打印前 100 行以免刷屏
        shown = 0
        for depth, ref, resolved in self.dep_tree:
            indent = "  " * depth
            prefix = "├─ " if depth > 0 else "└─ "
            src = ref if depth > 0 else resolved
            print(f"{indent}{prefix}{src}")
            shown += 1
            if shown >= 200:
                remaining = len(self.dep_tree) - shown
                if remaining > 0:
                    print(f"  ... 还有 {remaining} 个文件未显示")
                break
        print(f"    (共处理 {len(self.dep_tree)} 个文件)")
        print()

    def _print_manifest(self):
        """打印所有收集到的顶层元素清单。"""
        print("═" * 60)
        print("📋  顶层元素清单（按来源文件分组）")
        print("═" * 60)
        # 按来源文件分组
        by_file: dict[str, list] = defaultdict(list)
        for tag, eid, src, line in self.manifest:
            by_file[src].append((tag, eid, line))

        for file_idx, (src, elems) in enumerate(sorted(by_file.items()), 1):
            if file_idx > 50:
                remaining = len(by_file) - 50
                print(f"\n  ... 还有 {remaining} 个文件的元素未显示")
                break
            print(f"\n  📄 {src} ({len(elems)} 个元素):")
            for tag, eid, line in sorted(elems, key=lambda x: (x[0], x[1])):
                loc = f" (行 {line})" if line else ""
                print(f"    • <{tag} id=\"{eid}\">{loc}")

        total = len(self.manifest)
        print(f"\n  共 {total} 个顶层元素")
        print()

    def _print_conflicts(self, conflicts: dict):
        """打印重复 ID 冲突报告。"""
        print("═" * 60)
        print("⚠️  重复 ID 冲突报告")
        print("═" * 60)
        if not conflicts:
            print("  （无冲突）")
            return

        # 按元素类型分组显示
        by_type: dict[str, list] = defaultdict(list)
        for (tag, eid), locations in conflicts.items():
            by_type[tag].append((eid, locations))

        total_conflicts = len(conflicts)
        total_duplicates = sum(len(v) for v in conflicts.values())

        for tag, items in sorted(by_type.items()):
            print(f"\n  ── <{tag}> ({len(items)} 个重复 id) ──")
            for eid, locations in sorted(items):
                print(f"\n    id=\"{eid}\" — 出现 {len(locations)} 次:")
                for src, line in locations:
                    loc = f" (行 {line})" if line else ""
                    print(f"      • {src}{loc}")

        print(f"\n  📊 总计: {total_conflicts} 组冲突，涉及 {total_duplicates} 个引用")
        print()

    def _print_not_found(self):
        """打印找不到的文件列表。"""
        if not self.not_found:
            return
        print("═" * 60)
        print("⚠️  未找到的文件")
        print("═" * 60)
        shown = 0
        for src, parent in self.not_found:
            if shown >= 30:
                remaining = len(self.not_found) - shown
                print(f"  ... 还有 {remaining} 个未显示")
                break
            print(f"  • {src}  (引用自 {parent})")
            shown += 1
        print(f"  共 {len(self.not_found)} 个文件未找到")
        print()

    def _print_errors(self):
        """打印解析错误。"""
        if not self.errors:
            return
        print("═" * 60)
        print("❌  解析错误")
        print("═" * 60)
        for err in self.errors:
            print(err)
        print()


# ══════════════════════════════════════════════════════════════════════
#  命令行入口
# ══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="RA3 Quantum Compiler XML 重复 ID 检测工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  %(prog)s --sdk-dir C:\\Apps\\Ra3QuantumCompiler
  %(prog)s --sdk-dir C:\\Apps\\Ra3QuantumCompiler --project-dir D:\\Mods\\CoronaMod\\mods\\mods\\corona
  %(prog)s --sdk-dir C:\\Apps\\Ra3QuantumCompiler --cwd D:\\Mods\\CoronaMod\\mods\\mods\\corona

路径自动推断规则:
  DATA: 搜索路径 = {sdk} → {project}/Data → {mods} → {sdk}/SageXml
  ART:  搜索路径 = {sdk} → {project}/Art1 → {project}/Art → {mods}
  AUDIO:搜索路径 = {sdk} → {project}/Audio1 → {project}/Audio → {mods}
  其中 mods = {project}/..
        """
    )
    parser.add_argument(
        '--sdk-dir',
        default=None,
        help='RA3 Mod SDK 目录',
    )
    parser.add_argument(
        '--project-dir',
        default=None,
        help='项目根目录（默认: 自动检测，从当前目录向上查找含 Data/Mod.xml 的目录）',
    )
    parser.add_argument(
        '--cwd',
        default=None,
        help='工作目录（默认等于 --project-dir）',
    )

    args = parser.parse_args()

    # ── 确定项目目录 ──
    project_dir = None
    if args.project_dir:
        project_dir = Path(args.project_dir)
    else:
        # 自动检测：从当前目录向上找 Data/Mod.xml
        cur = Path.cwd()
        for p in [cur] + list(cur.parents):
            if (p / 'Data' / 'Mod.xml').is_file():
                project_dir = p
                break
        if project_dir is None:
            print("❌ 无法自动检测项目目录（未找到 Data/Mod.xml）", file=sys.stderr)
            print("   请使用 --project-dir 参数指定", file=sys.stderr)
            sys.exit(2)

    if args.sdk_dir is None:
        print("❌ 未指定 SDK 目录", file=sys.stderr)
        sys.exit(2)
    sdk_dir = Path(args.sdk_dir)
    cwd = Path(args.cwd) if args.cwd else project_dir

    # ── 检查基本路径有效性 ──
    if not sdk_dir.is_dir():
        print(f"❌ SDK 目录不存在: {sdk_dir}", file=sys.stderr)
        sys.exit(2)
    if not project_dir.is_dir():
        print(f"❌ 项目目录不存在: {project_dir}", file=sys.stderr)
        sys.exit(2)

    checker = DuplicateIdChecker(sdk_dir=sdk_dir, project_dir=project_dir, cwd=cwd)
    sys.exit(checker.run())


if __name__ == '__main__':
    main()
