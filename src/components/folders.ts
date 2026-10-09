import Gtk from "gi://Gtk?version=4.0";
import { INDENT, ROW_VERTICAL_GAP } from "../theme";
import type { Expansion } from "./expansion";
import { column, horizontal, label } from "./index";
import { folderIcon, type Selection, type Unread } from "./sidebar";

interface FolderNode {
  path: string;
  children: Map<string, FolderNode>;
}

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function populate(container: Gtk.Box, folders: string[], unread: Unread, expansion: Expansion, selection: Selection, select: (folder: string) => void) {
  const root: FolderNode = { path: "", children: new Map() };
  for (const folder of folders) {
    if (folder.toLowerCase() === "inbox") continue;
    let node = root;
    const path: string[] = [];
    for (const segment of folder.split("/")) {
      path.push(segment);
      const child = node.children.get(segment) ?? { path: "", children: new Map() };
      node.children.set(segment, child);
      child.path = path.join("/");
      node = child;
    }
  }
  unread.clearFolderLabels();
  append(container, root, unread, expansion, selection, select, 1);
}

function append(container: Gtk.Box, node: FolderNode, unread: Unread, expansion: Expansion, selection: Selection, select: (folder: string) => void, depth: number) {
  for (const [name, child] of [...node.children].sort(([a], [b]) => byteOrder(a, b))) {
    const row = column("folder-item");
    const content = horizontal("folder-content", ROW_VERTICAL_GAP);
    const hasChildren = child.children.size > 0;
    const icon = Gtk.Image.new_from_icon_name(hasChildren ? (expansion.isExpanded(child.path) ? "pan-down-symbolic" : "pan-end-symbolic") : folderIcon(child.path));
    content.append(icon);
    const title = label(name, "folder-text");
    unread.bind(child.path, title);
    content.append(title);
    const button = new Gtk.Button({ child: content, hexpand: true, cssClasses: ["flat", "folder-button"], marginStart: INDENT * depth });
    row.append(button);
    const children = column("folder-children");
    expansion.bind(child.path, children);
    append(children, child, unread, expansion, selection, select, depth + 1);
    row.append(children);
    button.connect("clicked", (button) => {
      if (hasChildren) {
        const expanded = !children.get_visible();
        children.set_visible(expanded);
        icon.set_from_icon_name(expanded ? "pan-down-symbolic" : "pan-end-symbolic");
      } else {
        selection.activate(button);
        select(child.path);
      }
    });
    container.append(row);
  }
}
