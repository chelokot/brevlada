import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { SETTINGS_HEIGHT, SETTINGS_WIDTH } from "../theme";

export function menu(): [Gtk.MenuButton, Gio.SimpleAction] {
  const settings = new Gio.SimpleAction({ name: "settings" });
  const actions = new Gio.SimpleActionGroup();
  actions.add_action(settings);
  const model = new Gio.Menu();
  model.append("Settings", "window.settings");
  model.append("Quit", "app.quit");
  const button = new Gtk.MenuButton({
    iconName: "open-menu-symbolic",
    tooltipText: "Main menu",
    menuModel: model,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    cssClasses: ["flat"],
  });
  button.insert_action_group("window", actions);
  return [button, settings];
}

function section(window: Adw.PreferencesWindow, title: string, icon: string, content: Adw.PreferencesPage) {
  const toolbar = new Adw.ToolbarView({ content });
  toolbar.add_top_bar(new Adw.HeaderBar());
  const page = Adw.NavigationPage.new(toolbar, title);
  const row = new Adw.ActionRow({ title, activatable: true });
  row.add_prefix(Gtk.Image.new_from_icon_name(icon));
  row.add_suffix(Gtk.Image.new_from_icon_name("go-next-symbolic"));
  const windows = new WeakRef(window);
  row.connect("activated", () => windows.deref()?.push_subpage(page));
  return row;
}

export class SettingsWindow {
  readonly window: Adw.PreferencesWindow;
  readonly trustAllSenders: Adw.SwitchRow;

  constructor(parent: Gtk.Window, trustAllSenders: boolean) {
    this.window = new Adw.PreferencesWindow({
      title: "Settings",
      transientFor: parent,
      modal: true,
      destroyWithParent: true,
      searchEnabled: false,
      defaultWidth: SETTINGS_WIDTH,
      defaultHeight: SETTINGS_HEIGHT,
    });
    this.window.set_application(parent.get_application());
    const privacy = new Adw.PreferencesPage({ title: "Privacy", iconName: "changes-prevent-symbolic" });
    const trust = new Adw.PreferencesGroup();
    this.trustAllSenders = new Adw.SwitchRow({ title: "Trust all senders", subtitle: "Automatically load message media from all senders", active: trustAllSenders });
    trust.add(this.trustAllSenders);
    privacy.add(trust);
    const overview = new Adw.PreferencesPage({ title: "Settings" });
    const sections = new Adw.PreferencesGroup();
    sections.add(section(this.window, "Privacy", "changes-prevent-symbolic", privacy));
    overview.add(sections);
    const general = new Adw.PreferencesPage({ title: "General", iconName: "preferences-system-symbolic" });
    const background = new Adw.SwitchRow({ title: "Background service", subtitle: "Keep checking for new mail when the window is closed", actionName: "app.background" });
    const service = new Adw.PreferencesGroup();
    service.add(background);
    general.add(service);
    sections.add(section(this.window, "General", "preferences-system-symbolic", general));
    this.window.add(overview);
  }
}
