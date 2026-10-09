import Gtk from "gi://Gtk?version=4.0";
import { AVATAR_SIZE, SPACING, STATE_ICON } from "../theme";
import { clear, column, label } from "./index";

export const placeholder = (text: string, cssClass: string, icon: string, loading: boolean) => placeholderWithTextOpacity(text, cssClass, icon, loading, 0.7);

function placeholderWithTextOpacity(text: string, cssClass: string, icon: string, loading: boolean, textOpacity: number) {
  const content = column(cssClass);
  content.add_css_class("message-state");
  content.set_halign(Gtk.Align.CENTER);
  content.set_valign(Gtk.Align.CENTER);
  content.set_hexpand(true);
  content.set_vexpand(true);
  content.set_spacing(SPACING);
  if (loading) content.append(new Gtk.Spinner({ spinning: true, widthRequest: AVATAR_SIZE, heightRequest: AVATAR_SIZE }));
  else {
    const image = Gtk.Image.new_from_icon_name(icon);
    image.set_pixel_size(STATE_ICON);
    image.set_opacity(0.5);
    content.append(image);
  }
  const caption = label(text, "state-text");
  caption.set_halign(Gtk.Align.CENTER);
  caption.set_opacity(textOpacity);
  caption.set_wrap(true);
  content.append(caption);
  return content;
}

function viewerState(viewer: Gtk.Box, text: string, loading: boolean) {
  clear(viewer);
  viewer.set_vexpand(true);
  viewer.append(placeholder(text, "message-viewer-empty-state", "mail-unread-symbolic", loading));
}

export const selectMessage = (viewer: Gtk.Box) => viewerState(viewer, "Select message to view", false);

export const loadingThread = (viewer: Gtk.Box) => viewerState(viewer, "Loading conversation...", true);

export function listState(stack: Gtk.Stack, text: string, loading: boolean, error: boolean) {
  const cssClass = error ? "message-list-error-state" : loading ? "message-list-loading-state" : "message-list-empty-state";
  const state = placeholder(text, cssClass, error ? "dialog-error-symbolic" : "folder-symbolic", loading);
  if (error) state.add_css_class("error");
  showListState(stack, state);
}

export const noSendersFound = (stack: Gtk.Stack) =>
  showListState(stack, placeholderWithTextOpacity("No senders found", "message-list-empty-state", "system-search-symbolic", false, 1));

function showListState(stack: Gtk.Stack, state: Gtk.Box) {
  const previous = stack.get_child_by_name("state");
  if (previous) stack.remove(previous);
  stack.add_named(state, "state");
  stack.set_visible_child_name("state");
}

export function refreshing(button: Gtk.Button, loading: boolean) {
  if (loading) button.set_child(new Gtk.Spinner({ spinning: true }));
  else button.set_icon_name("view-refresh-symbolic");
}
