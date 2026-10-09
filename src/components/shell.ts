import Adw from "gi://Adw?version=1";
import GObject from "gi://GObject?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { CSS, LIST_WIDTH, SIDEBAR_HEADER_WIDTH, SIDEBAR_WIDTH, SMALL_SPACING, WINDOW_HEIGHT, WINDOW_WIDTH } from "../theme";
import { button, column, label, pane, scroll } from "./index";
import { Sidebar } from "./motion";
import { remember } from "./pane-state";
import { Reveal } from "./reveal";
import { SearchFilters } from "./search-filters";
import { container } from "./sender-menu";
import { menu } from "./settings";
import { SortMenu } from "./sort-menu";
import { listState, selectMessage } from "./states";
import { SyncStatus } from "./sync-status";
import { create as createList, scroll as listScroll } from "./virtual-list";

export type Shell = ReturnType<typeof createShell>;

function searchControls(header: Adw.HeaderBar, parent: Gtk.Box, prompt: string, filters: Gtk.Box | null) {
  const toggle = new Gtk.ToggleButton({ iconName: "system-search-symbolic", tooltipText: prompt, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, cssClasses: ["flat"] });
  header.pack_start(toggle);
  const entry = new Gtk.SearchEntry({ placeholderText: prompt, widthChars: 1, hexpand: true, halign: Gtk.Align.FILL, searchDelay: 150 });
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });
  if (filters) content.append(filters);
  content.append(entry);
  const bar = new Gtk.SearchBar({ child: content, searchModeEnabled: false, cssClasses: ["message-list-search-box"] });
  bar.connect_entry(entry);
  toggle.bind_property("active", bar, "search-mode-enabled", GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);
  toggle.connect("toggled", (toggle) => {
    if (toggle.get_active()) entry.grab_focus();
  });
  parent.append(bar);
  return entry;
}

const searchSpinner = () => new Gtk.Spinner({ spinning: true, visible: false, halign: Gtk.Align.CENTER, heightRequest: 20, widthRequest: 20, marginTop: 6, marginBottom: 6, tooltipText: "Searching…" });

export function createShell(app: Adw.Application) {
  const window = new Adw.ApplicationWindow({ application: app, title: "Brevlada Email Client", defaultWidth: WINDOW_WIDTH, defaultHeight: WINDOW_HEIGHT });
  const display = window.get_display();
  const css = new Gtk.CssProvider();
  css.load_from_string(CSS);
  Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  Gtk.IconTheme.get_for_display(display).add_resource_path("/org/gtk/example/icons");
  const sidebarColumn = column("sidebar-wrapper");
  const syncStatus = new SyncStatus();
  const sidebarHeader = new Adw.HeaderBar({ titleWidget: syncStatus.widget, showEndTitleButtons: false, widthRequest: SIDEBAR_HEADER_WIDTH, cssClasses: ["sidebar-header"] });
  const sync = button("view-refresh-symbolic", "Sync accounts now");
  sync.set_sensitive(false);
  sidebarHeader.pack_start(sync);
  const collapseSidebar = button("sidebar-show-symbolic", "Collapse sidebar");
  sidebarHeader.pack_end(collapseSidebar);
  sidebarColumn.append(sidebarHeader);
  const sidebar = column("navigation-list");
  const sidebarWrapper = column("sidebar");
  sidebarWrapper.append(scroll(sidebar));
  sidebarColumn.append(sidebarWrapper);
  const middle = column("message-list-wrapper");
  const accountTitle = new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, maxWidthChars: 40, cssClasses: ["title"], visible: false });
  const listHeader = new Adw.HeaderBar({ titleWidget: accountTitle, showEndTitleButtons: false, widthRequest: LIST_WIDTH, cssClasses: ["message-list-header"] });
  const composeButton = button("mail-message-new-symbolic", "Compose message");
  const back = button("go-previous-symbolic", "Back to senders");
  back.set_visible(false);
  const expandSidebar = button("sidebar-show-symbolic", "Expand sidebar");
  listHeader.pack_start(expandSidebar);
  const refresh = button("view-refresh-symbolic", "Refresh messages");
  refresh.set_sensitive(false);
  listHeader.pack_start(refresh);
  middle.append(listHeader);
  const searchFilters = new SearchFilters();
  const search = searchControls(listHeader, middle, "Search senders and messages", searchFilters.widget);
  const senderUnreadFirst = new SortMenu();
  listHeader.pack_end(senderUnreadFirst.widget);
  const list = createList();
  const listScrolled = listScroll(list);
  const searchProgress: [Gtk.Spinner, Gtk.Spinner] = [searchSpinner(), searchSpinner()];
  middle.append(searchProgress[0]);
  const listStack = new Gtk.Stack({ hexpand: true, vexpand: true });
  const listRoot = container(listScrolled);
  listRoot.add_css_class("message-list-root");
  listStack.add_named(listRoot, "list");
  listState(listStack, "No messages in this folder", false, false);
  middle.append(listStack);
  const threadColumn = column("message-list-wrapper");
  const threadHeader = new Adw.HeaderBar({
    titleWidget: new Gtk.Label({ label: "Messages" }),
    showStartTitleButtons: false,
    showEndTitleButtons: false,
    widthRequest: LIST_WIDTH,
    cssClasses: ["message-list-header"],
  });
  threadHeader.pack_start(back);
  const threadUnreadFirst = new SortMenu();
  threadHeader.pack_end(threadUnreadFirst.widget);
  threadColumn.append(threadHeader);
  const threadSearch = searchControls(threadHeader, threadColumn, "Search this sender’s messages", null);
  threadColumn.append(searchProgress[1]);
  const threadList = createList();
  const threadLoadMore = Gtk.Button.new_with_label("Retry loading");
  threadLoadMore.add_css_class("message-list-more");
  threadLoadMore.set_halign(Gtk.Align.CENTER);
  threadLoadMore.set_valign(Gtk.Align.END);
  threadLoadMore.set_margin_bottom(SMALL_SPACING);
  threadLoadMore.set_visible(false);
  const threadScroll = listScroll(threadList);
  const threadOverlay = new Gtk.Overlay({ hexpand: true, vexpand: true, child: threadScroll });
  threadOverlay.add_overlay(threadLoadMore);
  const threadRoot = container(threadOverlay);
  threadRoot.add_css_class("message-list-root");
  const threadStack = new Gtk.Stack({ hexpand: true, vexpand: true });
  threadStack.add_named(threadRoot, "list");
  threadColumn.append(threadStack);
  const right = column("content-wrapper");
  const header = new Adw.HeaderBar({
    titleWidget: new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 }),
    centeringPolicy: Adw.CenteringPolicy.STRICT,
    hexpand: true,
    cssClasses: ["content-header"],
  });
  header.pack_start(composeButton);
  const [settingsMenu, settings] = menu();
  header.pack_end(settingsMenu);
  const headers = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
  for (const bar of [sidebarHeader, listHeader, header, threadHeader]) headers.add_widget(bar);
  right.append(header);
  const viewer = column("message-container");
  selectMessage(viewer);
  const viewerRoot = column("message-viewer-root");
  viewerRoot.set_hexpand(true);
  viewerRoot.set_vexpand(true);
  const composers = column("compose-container");
  const viewerContent = column("message-viewer-content");
  viewerContent.append(composers);
  viewerContent.append(viewer);
  const viewerScroll = scroll(new Gtk.Viewport({ child: viewerContent, scrollToFocus: false }));
  const viewerReveal = new Reveal(viewerScroll);
  viewerRoot.append(viewerReveal);
  right.append(viewerRoot);
  const threadSidebar = new Sidebar(threadColumn, right, LIST_WIDTH, false);
  const content = pane(middle, threadSidebar.pane, LIST_WIDTH);
  const accountSidebar = new Sidebar(sidebarColumn, content, SIDEBAR_WIDTH, true);
  remember(window, accountSidebar, content, threadSidebar);
  expandSidebar.set_visible(!accountSidebar.getVisible());
  accountSidebar.connectVisibleNotify((sidebar) => {
    expandSidebar.set_visible(!sidebar.getVisible());
    accountTitle.set_visible(!sidebar.getVisible() && accountTitle.get_text() !== "");
  });
  collapseSidebar.connect("clicked", () => {
    accountSidebar.setVisible(false);
    expandSidebar.grab_focus();
  });
  expandSidebar.connect("clicked", () => {
    accountSidebar.setVisible(true);
    collapseSidebar.grab_focus();
  });
  const toast = new Adw.ToastOverlay({ child: new Adw.ToolbarView({ content: accountSidebar.pane, topBarStyle: Adw.ToolbarStyle.FLAT }) });
  window.set_content(toast);
  return {
    window,
    sidebar,
    accountSidebar,
    accountTitle,
    threadSidebar,
    threadList,
    threadScroll,
    threadStack,
    syncStatus,
    list,
    listScroll: listScrolled,
    threadLoadMore,
    viewerScroll,
    listStack,
    viewer,
    viewerReveal,
    composeButton,
    composers,
    refresh,
    sync,
    back,
    senderUnreadFirst,
    threadUnreadFirst,
    search,
    searchProgress,
    searchFilters,
    threadSearch,
    toast,
    settings,
  };
}

export const noAccounts = (sidebar: Gtk.Box) => sidebar.append(label("No accounts found", "dim-label"));
