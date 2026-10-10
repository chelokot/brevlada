import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Parcel, Step } from "../models/parcel";
import { at } from "../models/schema";
import { sameAscii } from "../models/text";
import { format, local } from "../models/time";
import { SPACING } from "../theme";
import { popup } from "./details";
import { actionButton } from "./index";
import { open } from "./links";
import { address, date, type Detail, sections, web } from "./parcel/details";

function label(value: string, cssClass: string) {
  const label = Gtk.Label.new(value);
  label.set_xalign(0);
  label.set_wrap(true);
  if (cssClass) label.add_css_class(cssClass);
  return label;
}

function stepButton(step: Step, complete: boolean, single: boolean) {
  const content = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 6);
  const icon = Gtk.Image.new_from_icon_name("truck-symbolic");
  icon.set_valign(Gtk.Align.CENTER);
  if (!single) icon.add_css_class(complete ? "parcel-step-done" : "parcel-step-pending");
  content.append(icon);
  if (step.name !== null) content.append(label(step.name, single ? "parcel-single-step-name" : "parcel-step-name"));
  const button = new Gtk.Button({ child: content, valign: Gtk.Align.CENTER });
  button.add_css_class("flat");
  button.add_css_class(single ? "parcel-single-step" : "parcel-step");
  button.connect("clicked", (clicked) =>
    popup(clicked, step.name ?? "Delivery update", [step.date === null ? null : date(step.date), step.location].filter((part) => part !== null).join("\n")),
  );
  return button;
}

function orderPopup(anchor: Gtk.Button, parcel: Parcel, timestamp: number) {
  const window = new Adw.Window({ title: "Order Details", defaultWidth: 460, defaultHeight: 560, modal: true });
  const parent = anchor.get_root();
  if (parent instanceof Gtk.Window) window.set_transient_for(parent);
  const content = Gtk.Box.new(Gtk.Orientation.VERTICAL, 18);
  content.set_margin_top(18);
  content.set_margin_bottom(18);
  content.set_margin_start(18);
  content.set_margin_end(18);
  const groups = sections(parcel.details);
  const emailDate: Detail = { title: "Email date", value: format(local(timestamp), "%A, %-d %B %Y at %H:%M"), url: null };
  const delivery = groups.find((section) => section.title === "Delivery");
  if (delivery) delivery.rows.unshift(emailDate);
  else groups.unshift({ title: "Delivery", rows: [emailDate] });
  const hasOrderLink = groups.some((section) => section.rows.some((row) => row.url !== null && row.url === parcel.orderUrl));
  for (const section of groups) {
    const group = new Adw.PreferencesGroup({ title: section.title });
    for (const { title, value, url } of section.rows) {
      const row = new Adw.ActionRow({ title, useMarkup: false });
      if (url !== null) {
        const link = Gtk.Button.new_with_label(value);
        link.add_css_class("flat");
        link.set_valign(Gtk.Align.CENTER);
        link.connect("clicked", () => open(url));
        row.add_suffix(link);
        row.set_activatable_widget(link);
      } else {
        row.set_subtitle(value);
        row.set_subtitle_selectable(true);
      }
      group.add(row);
    }
    content.append(group);
  }
  if (content.get_first_child() === null) content.append(label("No additional order details available.", "dim-label"));
  const layout = Gtk.Box.new(Gtk.Orientation.VERTICAL, 12);
  layout.append(new Gtk.ScrolledWindow({ child: content, hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true }));
  const orderUrl = parcel.orderUrl;
  if (!hasOrderLink && orderUrl !== null && web(orderUrl)) {
    const link = actionButton("web-browser-symbolic", "View order");
    link.connect("clicked", () => open(orderUrl));
    link.set_margin_start(18);
    link.set_margin_end(18);
    link.set_margin_bottom(18);
    layout.append(link);
  }
  const toolbar = new Adw.ToolbarView();
  const header = new Adw.HeaderBar();
  header.set_title_widget(Adw.WindowTitle.new("Order Details", ""));
  toolbar.add_top_bar(header);
  toolbar.set_content(layout);
  window.set_content(toolbar);
  window.present();
}

export function card(parcel: Parcel, timestamp: number) {
  const card = Gtk.Box.new(Gtk.Orientation.VERTICAL, 12);
  card.add_css_class("parcel-card");
  if (parcel.item !== null) card.append(label(parcel.item, "title-2"));
  if (parcel.arrivalUntil !== null) {
    const until = date(parcel.arrivalUntil);
    const row = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 8);
    row.append(Gtk.Image.new_from_icon_name("truck-symbolic"));
    row.append(label(parcel.arrivalFrom === null ? `Arriving by ${until}` : `Arriving on ${date(parcel.arrivalFrom)} – ${until}`, "title-4"));
    card.append(row);
  }
  const carrier = parcel.carrier === null ? "" : parcel.carrier.trim();
  const delivery = [carrier ? `by ${carrier}` : null, address(at(parcel.details, "deliveryAddress"))].filter((part) => part !== null).join(" · ");
  if (delivery) card.append(label(delivery, "dim-label"));
  const status = at(parcel.details, "deliveryStatus");
  if (parcel.steps.length === 0 && typeof status === "string" && !status.includes("://")) {
    const row = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 6);
    row.add_css_class("parcel-single-step");
    row.append(Gtk.Image.new_from_icon_name("truck-symbolic"));
    row.append(label(status, "parcel-single-step-name"));
    card.append(row);
  }
  const delivered = parcel.steps.some((step) => step.name !== null && sameAscii(step.name, "delivered"));
  const expected = parcel.steps.length > 0 && parcel.arrivalUntil !== null && !delivered;
  const steps = expected ? [...parcel.steps, { name: "Expected delivery", date: parcel.arrivalUntil, location: null }] : parcel.steps;
  if (steps.length > 0) {
    const timeline = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, SPACING);
    timeline.add_css_class("parcel-timeline");
    steps.forEach((step, index) => {
      if (index > 0) {
        const line = Gtk.Separator.new(Gtk.Orientation.HORIZONTAL);
        line.set_hexpand(true);
        line.set_valign(Gtk.Align.CENTER);
        line.add_css_class("parcel-line");
        timeline.append(line);
      }
      timeline.append(stepButton(step, !(expected && index === steps.length - 1), steps.length === 1));
    });
    card.append(new Gtk.ScrolledWindow({ child: timeline, hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC, vscrollbarPolicy: Gtk.PolicyType.NEVER }));
  }
  const actions = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 8);
  const tracking = parcel.trackingUrl;
  if (tracking !== null && web(tracking)) {
    const track = actionButton("web-browser-symbolic", "Track Package");
    track.connect("clicked", () => open(tracking));
    actions.append(track);
  }
  const order = actionButton("document-properties-symbolic", "Order Details");
  order.connect("clicked", (clicked) => orderPopup(clicked, parcel, timestamp));
  actions.append(order);
  const number = parcel.orderNumber;
  if (parcel.orderUrl === null && number !== null) {
    const copy = Gtk.Button.new_with_label(`Order ${number}`);
    copy.add_css_class("flat");
    copy.set_tooltip_text("Copy order number");
    copy.connect("clicked", (clicked) => clicked.get_clipboard().set(number));
    actions.append(copy);
  }
  card.append(actions);
  return card;
}
